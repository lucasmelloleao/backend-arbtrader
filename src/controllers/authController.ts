import { Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import speakeasy from 'speakeasy';
import User from '../models/User';
import { AuthenticatedRequest } from '../middleware/authMiddleware';
import {
  sendLoginNotificationEmail,
  sendPasswordChangedNotificationEmail,
  sendResetPasswordCodeEmail
} from '../utils/email';

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_for_flash_loan';

function signToken(userId: string) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

export async function login(req: AuthenticatedRequest, res: Response) {
  try {
    const { email, password, twoFactorToken } = req.body;
    const isDashboardPath = req.path.includes('/auth/');

    if (!email || !password) {
      const errorMsg = 'E-mail e senha são obrigatórios.';
      return res.status(400).json(isDashboardPath ? { error: 'Missing fields' } : { success: false, message: errorMsg });
    }

    const user = await User.findOne({ email });
    if (!user) {
      const errorMsg = 'Credenciais inválidas.';
      return res.status(401).json(isDashboardPath ? { error: 'Invalid credentials' } : { success: false, message: errorMsg });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      const errorMsg = 'Credenciais inválidas.';
      return res.status(401).json(isDashboardPath ? { error: 'Invalid credentials' } : { success: false, message: errorMsg });
    }

    if (user.twoFactorEnabled) {
      if (!twoFactorToken) {
        return res.status(401).json(isDashboardPath ? { error: '2fa_required' } : { success: false, message: '2fa_required' });
      }

      const verified = speakeasy.totp.verify({
        secret: user.twoFactorSecret,
        encoding: 'base32',
        token: twoFactorToken,
        window: 1
      });

      if (!verified) {
        const errorMsg = 'Código 2FA inválido.';
        return res.status(401).json(isDashboardPath ? { error: 'Invalid 2FA code' } : { success: false, message: errorMsg });
      }
    }

    const token = signToken(user._id.toString());
    const rememberMe = req.body.rememberMe;
    const cookieMaxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    // Configura os cookies session_token, refresh_token e token
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: false, // Permite HTTP localmente
      sameSite: 'lax',
      maxAge: cookieMaxAge
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: cookieMaxAge
    });

    if (rememberMe) {
      const refreshToken = jwt.sign({ userId: user._id.toString() }, JWT_SECRET, { expiresIn: '30d' });
      res.cookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000
      });
    }

    // Dispara notificação por e-mail sem travar a resposta
    sendLoginNotificationEmail(user.email, user.name);

    if (isDashboardPath) {
      return res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
    } else {
      return res.json({
        success: true,
        message: 'Login realizado.',
        data: {
          user: {
            id: user._id.toString(),
            name: user.name,
            email: user.email
          }
        }
      });
    }
  } catch (error: any) {
    console.error('❌ [Login Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

export async function register(req: AuthenticatedRequest, res: Response) {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashedPassword });

    const token = signToken(user._id.toString());

    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    return res.status(201).json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (error: any) {
    console.error('❌ [Register Controller] Error:', error?.message);
    return res.status(500).json({ error: error.message });
  }
}

export async function google(req: AuthenticatedRequest, res: Response) {
  try {
    const { credential } = req.body;

    if (!credential) {
      return res.status(400).json({ error: 'Missing Google credential' });
    }

    const parts = credential.split('.');
    if (parts.length !== 3) {
      return res.status(400).json({ error: 'Invalid Google credential token' });
    }

    const payloadBuffer = Buffer.from(parts[1], 'base64');
    const payload = JSON.parse(payloadBuffer.toString('utf-8'));

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return res.status(400).json({ error: 'Google credential expired' });
    }

    const email = payload.email;
    const name = payload.name || payload.given_name || 'Google User';

    if (!email) {
      return res.status(400).json({ error: 'Google credential has no email' });
    }

    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name,
        email,
        password: 'google-oauth-placeholder-password-' + Math.random().toString(36).substring(2),
      });
    }

    const token = signToken(user._id.toString());

    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    sendLoginNotificationEmail(user.email, user.name);

    return res.json({ token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (error: any) {
    console.error('❌ [Google Auth Controller] Error:', error?.message);
    return res.status(500).json({ error: error.message });
  }
}

export async function logout(req: AuthenticatedRequest, res: Response) {
  res.clearCookie('session_token');
  res.clearCookie('refresh_token');
  res.clearCookie('token');
  return res.json({ success: true, message: 'Sessão encerrada.' });
}

export async function forgotPassword(req: AuthenticatedRequest, res: Response) {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'E-mail é obrigatório' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // Por segurança, retorna mensagem de sucesso sem expor que o e-mail não existe
      return res.json({
        message: 'Se o e-mail estiver cadastrado, você receberá o código de verificação.',
      });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos

    user.resetPasswordCode = code;
    user.resetPasswordExpires = expiresAt;
    await user.save();

    sendResetPasswordCodeEmail(user.email, user.name, code);

    return res.json({
      message: 'Se o e-mail estiver cadastrado, você receberá o código de verificação.',
    });
  } catch (error: any) {
    console.error('❌ [Forgot Password Controller] Error:', error?.message);
    return res.status(500).json({ error: error.message || 'Erro ao gerar código de verificação' });
  }
}

export async function resetPassword(req: AuthenticatedRequest, res: Response) {
  try {
    const { email, code, newPassword } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'E-mail é obrigatório' });
    }

    if (!code || typeof code !== 'string' || code.trim().length !== 6) {
      return res.status(400).json({ error: 'O código de verificação deve ter 6 dígitos' });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    const savedCode = String(user.resetPasswordCode || '').trim();
    const inputCode = String(code || '').trim();

    if (!user.resetPasswordCode || savedCode !== inputCode) {
      return res.status(400).json({ error: 'Código de verificação incorreto ou inválido' });
    }

    if (!user.resetPasswordExpires || new Date() > new Date(user.resetPasswordExpires)) {
      return res.status(400).json({ error: 'O código de verificação expirou. Solicite um novo código.' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    user.resetPasswordCode = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    sendPasswordChangedNotificationEmail(user.email, user.name);

    return res.json({ message: 'Senha alterada com sucesso!' });
  } catch (error: any) {
    console.error('❌ [Reset Password Controller] Error:', error?.message);
    return res.status(500).json({ error: error.message || 'Erro ao redefinir a senha' });
  }
}

export async function changePassword(req: AuthenticatedRequest, res: Response) {
  try {
    const isDashboardPath = req.path.includes('/auth/');
    const oldPassword = req.body.oldPassword || req.body.senhaAntiga;
    const newPassword = req.body.newPassword || req.body.novaSenha;
    const userId = req.userId;

    if (!oldPassword || !newPassword) {
      return res.status(400).json(isDashboardPath ? { error: 'Missing fields' } : { success: false, message: 'Senha antiga e nova senha são obrigatórias.' });
    }

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json(isDashboardPath ? { error: 'User not found' } : { success: false, message: 'Usuário não encontrado.' });
    }

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) {
      return res.status(401).json(isDashboardPath ? { error: 'Incorrect old password' } : { success: false, message: 'Senha antiga incorreta.' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedNewPassword;
    await user.save();

    sendPasswordChangedNotificationEmail(user.email, user.name);

    if (isDashboardPath) {
      return res.json({ message: 'Password changed successfully' });
    } else {
      return res.json({ success: true, message: 'Senha alterada com sucesso.' });
    }
  } catch (error: any) {
    console.error('❌ [Change Password Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

export async function getMe(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const user = await User.findById(userId).select('-password');
    if (!user) {
      return res.status(404).json(isDashboardPath ? { error: 'User not found' } : { success: false, message: 'Usuário não encontrado.' });
    }

    const rawToken = user.telegramBotToken || '';
    const maskedToken = rawToken.length > 4 ? `***${rawToken.slice(-4)}` : (rawToken ? '***' : null);

    if (isDashboardPath) {
      return res.json({
        ...user.toObject(),
        telegramBotToken: maskedToken,
      });
    } else {
      return res.json({
        success: true,
        message: 'ok',
        data: {
          id: user._id.toString(),
          nome: user.name,
          email: user.email,
          telefone: user.telefone || null,
          twoFactorEnabled: user.twoFactorEnabled || false,
          telegramChatId: user.telegramChatId || null,
          telegramBotToken: maskedToken
        }
      });
    }
  } catch (error: any) {
    console.error('❌ [Get Me/Perfil Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

export async function updateMe(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json(isDashboardPath ? { error: 'User not found' } : { success: false, message: 'Usuário não encontrado.' });
    }

    const { telegramBotToken, telegramChatId, nome, email, telefone } = req.body;

    if (telegramChatId !== undefined) {
      user.telegramChatId = (telegramChatId || '').trim() || undefined;
    }
    if (telegramBotToken !== undefined && typeof telegramBotToken === 'string') {
      const trimmedToken = telegramBotToken.trim();
      // So atualiza se nao for o token mascarado devolvido no GET
      if (trimmedToken && !trimmedToken.startsWith('***')) {
        user.telegramBotToken = trimmedToken;
      } else if (!trimmedToken) {
        user.telegramBotToken = undefined;
      }
    }

    if (!isDashboardPath) {
      if (nome) user.name = nome.trim();
      if (telefone !== undefined) user.telefone = (telefone || '').trim() || undefined;
      if (email && email.trim().toLowerCase() !== user.email.toLowerCase()) {
        return res.status(400).json({ success: false, message: 'Não é permitido alterar o e-mail.' });
      }
    }

    await user.save();

    const rawToken = user.telegramBotToken || '';
    const maskedToken = rawToken.length > 4 ? `***${rawToken.slice(-4)}` : (rawToken ? '***' : null);

    if (isDashboardPath) {
      return res.json({
        success: true,
        message: 'Configurações salvas com sucesso!',
        telegramBotToken: maskedToken,
        telegramChatId: user.telegramChatId || null,
      });
    } else {
      return res.json({
        success: true,
        message: 'Perfil salvo.',
        data: {
          id: user._id.toString(),
          nome: user.name,
          email: user.email,
          telefone: user.telefone || null,
          twoFactorEnabled: user.twoFactorEnabled || false,
          telegramChatId: user.telegramChatId || null,
          telegramBotToken: maskedToken
        }
      });
    }
  } catch (error: any) {
    console.error('❌ [Update Me/Perfil Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: error.message } : { success: false, message: error.message });
  }
}

export async function generate2FA(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json(isDashboardPath ? { error: 'User not found' } : { success: false, message: 'Usuário não encontrado.' });
    }

    const secret = speakeasy.generateSecret({
      name: `ArbTrade (${user.email})`
    });

    user.twoFactorSecret = secret.base32;
    await user.save();

    if (isDashboardPath) {
      return res.json({
        secret: secret.base32,
        otpauthUrl: secret.otpauth_url
      });
    } else {
      return res.json({
        success: true,
        message: 'Código de pareamento gerado.',
        data: {
          secret: secret.base32,
          otpauthUrl: secret.otpauth_url
        }
      });
    }
  } catch (error: any) {
    console.error('❌ [Generate 2FA Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: 'Failed to generate 2FA' } : { success: false, message: 'Falha ao gerar 2FA.' });
  }
}

export async function verify2FA(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');
    const twoFactorToken = req.body.twoFactorToken || req.body.token;

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    if (!twoFactorToken) {
      return res.status(400).json(isDashboardPath ? { error: 'Token is required' } : { success: false, message: 'Código 2FA é obrigatório.' });
    }

    const user = await User.findById(userId);
    if (!user || !user.twoFactorSecret) {
      return res.status(404).json(isDashboardPath ? { error: 'User or 2FA secret not found' } : { success: false, message: 'Configuração de 2FA não encontrada.' });
    }

    const verified = speakeasy.totp.verify({
      secret: user.twoFactorSecret,
      encoding: 'base32',
      token: twoFactorToken,
      window: 1
    });

    if (!verified) {
      return res.status(400).json(isDashboardPath ? { error: 'Invalid 2FA token' } : { success: false, message: 'Código 2FA inválido.' });
    }

    user.twoFactorEnabled = true;
    await user.save();

    if (isDashboardPath) {
      return res.json({ success: true });
    } else {
      return res.json({ success: true, message: 'Autenticação de dois fatores ativada com sucesso.' });
    }
  } catch (error: any) {
    console.error('❌ [Verify 2FA Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: 'Failed to verify 2FA' } : { success: false, message: 'Falha ao verificar 2FA.' });
  }
}

export async function disable2FA(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = req.userId;
    const isDashboardPath = req.path.includes('/auth/');

    if (!userId) {
      return res.status(401).json(isDashboardPath ? { error: 'Unauthorized' } : { success: false, message: 'Não autorizado.' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json(isDashboardPath ? { error: 'User not found' } : { success: false, message: 'Usuário não encontrado.' });
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    await user.save();

    if (isDashboardPath) {
      return res.json({ success: true });
    } else {
      return res.json({ success: true, message: 'Autenticação de dois fatores desativada.' });
    }
  } catch (error: any) {
    console.error('❌ [Disable 2FA Controller] Error:', error?.message);
    const isDashboardPath = req.path.includes('/auth/');
    return res.status(500).json(isDashboardPath ? { error: 'Failed to disable 2FA' } : { success: false, message: 'Falha ao desativar 2FA.' });
  }
}

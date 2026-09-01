import { Response } from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../models/User';
import { AuthenticatedRequest } from '../middleware/authMiddleware';

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

function formatUser(u: any) {
  return {
    id: u._id.toString(),
    nome: u.name,
    email: u.email,
    telefone: u.telefone || null,
    createdAt: u.createdAt
  };
}

export async function getUsers(req: AuthenticatedRequest, res: Response) {
  try {
    const list = await User.find().select('-password -twoFactorSecret').sort({ createdAt: -1 });
    const formatted = list.map(formatUser);
    
    return res.json({
      success: true,
      message: 'ok',
      data: formatted
    });
  } catch (e: any) {
    console.error('❌ [GET Users] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function getUserById(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!id || !isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'ID inválido.' });
    }

    const u = await User.findById(id).select('-password -twoFactorSecret');
    if (!u) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    return res.json({
      success: true,
      message: 'ok',
      data: formatUser(u)
    });
  } catch (e: any) {
    console.error('❌ [GET User By ID] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function createUser(req: AuthenticatedRequest, res: Response) {
  try {
    const { nome, email, password, telefone } = req.body;
    if (!nome || !email || !password) {
      return res.status(400).json({ success: false, message: 'Nome, E-mail e Senha são obrigatórios.' });
    }

    const emailLower = email.toLowerCase().trim();
    const existing = await User.findOne({ email: emailLower });
    if (existing) {
      return res.status(400).json({ success: false, message: 'E-mail já cadastrado.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const u = await User.create({
      name: nome.trim(),
      email: emailLower,
      password: hashedPassword,
      telefone: telefone ? telefone.trim() : undefined
    });

    return res.status(201).json({
      success: true,
      message: 'Usuário criado com sucesso.',
      data: formatUser(u)
    });
  } catch (e: any) {
    console.error('❌ [POST User] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function updateUser(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    const { nome, email, password, telefone } = req.body;

    if (!id || !isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'ID inválido.' });
    }

    const u = await User.findById(id);
    if (!u) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    if (email) {
      const emailLower = email.toLowerCase().trim();
      if (emailLower !== u.email) {
        const existing = await User.findOne({ email: emailLower });
        if (existing) {
          return res.status(400).json({ success: false, message: 'E-mail já está em uso.' });
        }
        u.email = emailLower;
      }
    }

    if (nome) u.name = nome.trim();
    if (telefone !== undefined) u.telefone = telefone ? telefone.trim() : undefined;

    if (password && password.trim() !== '') {
      u.password = await bcrypt.hash(password, 10);
    }

    await u.save();

    return res.json({
      success: true,
      message: 'Usuário atualizado com sucesso.',
      data: formatUser(u)
    });
  } catch (e: any) {
    console.error('❌ [PUT User] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

export async function deleteUser(req: AuthenticatedRequest, res: Response) {
  try {
    const { id } = req.params;
    if (!id || !isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'ID inválido.' });
    }

    // Impede que o próprio usuário se exclua
    if (id === req.userId) {
      return res.status(400).json({ success: false, message: 'Não é possível excluir o próprio usuário autenticado.' });
    }

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
    }

    return res.json({
      success: true,
      message: 'Usuário removido com sucesso.'
    });
  } catch (e: any) {
    console.error('❌ [DELETE User] Error:', e.message);
    return res.status(500).json({ success: false, message: e.message });
  }
}

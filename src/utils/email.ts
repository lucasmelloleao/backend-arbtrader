import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');
const FROM_EMAIL = 'onboarding@resend.dev';

export async function sendLoginNotificationEmail(email: string, name: string) {
  try {
    const nowStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Novo Login Detectado - ArbTrade',
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #e2e8f0; padding: 30px; border-radius: 12px;">
          <h2 style="color: #6366f1; margin-bottom: 10px;">ArbTrade - Alerta de Login</h2>
          <p>Olá <strong>${name}</strong>,</p>
          <p>Identificamos um novo acesso à sua conta em <strong>${nowStr}</strong>.</p>
          <p style="font-size: 13px; color: #94a3b8; margin-top: 20px;">
            Se você realizou este login, pode ignorar este e-mail. Caso não tenha sido você, recomendamos alterar sua senha imediatamente.
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('❌ Falha ao enviar e-mail de notificação de login:', err?.message);
  }
}

export async function sendPasswordChangedNotificationEmail(email: string, name: string) {
  try {
    const nowStr = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Sua Senha foi Alterada - ArbTrade',
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #e2e8f0; padding: 30px; border-radius: 12px;">
          <h2 style="color: #6366f1; margin-bottom: 10px;">ArbTrade - Alteração de Senha</h2>
          <p>Olá <strong>${name}</strong>,</p>
          <p>Confirmamos que a senha da sua conta foi alterada com sucesso em <strong>${nowStr}</strong>.</p>
          <p style="font-size: 13px; color: #94a3b8; margin-top: 20px;">
            Se você não realizou esta alteração, entre em contato com o suporte ou redefina sua senha imediatamente.
          </p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('❌ Falha ao enviar e-mail de notificação de senha alterada:', err?.message);
  }
}

export async function sendResetPasswordCodeEmail(email: string, name: string, code: string) {
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: email,
      subject: 'Seu código para alteração de senha - ArbTrade',
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #0f172a; color: #e2e8f0; padding: 30px; border-radius: 12px;">
          <h2 style="color: #6366f1; margin-bottom: 10px;">ArbTrade - Alteração de Senha</h2>
          <p>Olá <strong>${name}</strong>,</p>
          <p>Você solicitou a alteração da sua senha. Utilize o código de 6 dígitos abaixo para confirmar:</p>
          <div style="background-color: #1e293b; padding: 15px 25px; border-radius: 8px; display: inline-block; font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #38bdf8; margin: 20px 0;">
            ${code}
          </div>
          <p style="font-size: 13px; color: #94a3b8;">Este código é válido por <strong>15 minutos</strong>. Caso você não tenha solicitado esta alteração, ignore este e-mail.</p>
        </div>
      `,
    });
  } catch (err: any) {
    console.error('❌ Falha ao enviar e-mail de recuperação de senha:', err?.message);
  }
}

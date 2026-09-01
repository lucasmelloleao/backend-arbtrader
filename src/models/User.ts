import mongoose from 'mongoose';

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true }, // will be hashed
  twoFactorSecret: { type: String, required: false },
  twoFactorEnabled: { type: Boolean, default: false },
  telegramBotToken: { type: String, required: false },
  telegramChatId: { type: String, required: false },
  resetPasswordCode: { type: String, required: false },
  resetPasswordExpires: { type: Date, required: false },
  telefone: { type: String, required: false },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.User || mongoose.model('User', UserSchema);

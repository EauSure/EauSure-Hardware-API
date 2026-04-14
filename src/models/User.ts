import mongoose, { Document, Schema } from 'mongoose';

export type UserRole = 'user' | 'admin';

export interface IUser extends Document {
  email: string;
  password?: string;
  googleId?: string;
  githubId?: string;
  name?: string;
  avatar?: string;
  authProvider: 'local' | 'google' | 'github';
  role: UserRole;
}

const UserSchema = new Schema<IUser>({
  email: { type: String, required: true, unique: true, trim: true },
  password: { type: String, default: null },
  googleId: { type: String, sparse: true, unique: true },
  githubId: { type: String, sparse: true, unique: true },
  name: { type: String, trim: true, default: '' },
  avatar: { type: String, default: '' },
  authProvider: {
    type: String,
    enum: ['local', 'google', 'github'],
    default: 'local',
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
    index: true,
  },
}, { timestamps: true });

export default mongoose.models.User || mongoose.model<IUser>('User', UserSchema);

import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Gym Dev Hub',
  description: 'AI-assisted development operations workspace',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="uk">
      <body>{children}</body>
    </html>
  );
}

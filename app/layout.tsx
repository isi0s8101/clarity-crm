import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clarity CRM — Pilotage commercial",
  description:
    "CRM modulaire pour piloter les ventes, automatiser les tâches et administrer les données sans complexité.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr">
      <body className="antialiased">{children}</body>
    </html>
  );
}

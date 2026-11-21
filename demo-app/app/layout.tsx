import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vigil demo shop",
  description: "Deliberately vulnerable demo app for the Vigil hackathon project",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

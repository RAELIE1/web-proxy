import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebProxy — Browse anonymously through any site",
  description:
    "A full-featured web proxy. Enter any URL and browse through the proxy with full asset support.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

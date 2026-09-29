import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ColabGPU — Drag, Drop, Run, Monitor",
  description: "WebGPU-powered notebook platform: drag & drop LLM/dataset files, run with one click, monitor GPU/RAM/SSD in real time, and test your model.",
  keywords: ["WebGPU", "LLM", "GPU", "monitoring", "Colab", "inference", "AI"],
  authors: [{ name: "ColabGPU" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-zinc-950 text-zinc-100 min-h-screen`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}

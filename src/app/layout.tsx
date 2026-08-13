import type { Metadata } from "next";
import { Montserrat, Geist_Mono } from "next/font/google";
import "./globals.css";

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AgentCore Console",
  description: "Streaming console for Amazon Bedrock AgentCore harness invocations.",
};

// Runs before hydration so the correct theme is set on first paint — reading
// localStorage in a client component's effect would flash the wrong theme
// for a frame first. Inert if the user has never toggled (no stored value),
// leaving the prefers-color-scheme media query in globals.css in control.
const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${montserrat.variable} ${geistMono.variable} h-full antialiased`}
      // THEME_INIT_SCRIPT below sets data-theme on this element before
      // hydration runs (that's the whole point — avoids a flash of the
      // wrong theme). React then sees a live DOM attribute the server
      // never rendered and flags it as a mismatch; suppressHydrationWarning
      // is the documented escape hatch for exactly this case — it only
      // silences the warning for this element's own attributes, not the
      // subtree, so it won't hide a real mismatch anywhere else.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-canvas text-ink">{children}</body>
    </html>
  );
}

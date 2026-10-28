"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** Apply the saved preference before first paint; new visitors start in dark.
 * Explicit light and system preferences remain available on public status pages.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}

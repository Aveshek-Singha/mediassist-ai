import { defineConfig, loadEnv, type IndexHtmlTransformContext } from 'vite';
import react from '@vitejs/plugin-react';

function dashboardSecurityHeaders(apiBaseUrl: string | undefined) {
  return {
    name: 'dashboard-content-security-policy',
    transformIndexHtml(html: string, context: IndexHtmlTransformContext) {
      if (context.server) return html;
      const connectSources = ["'self'"];
      if (apiBaseUrl?.trim()) {
        const apiUrl = new URL(apiBaseUrl.trim());
        if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password) throw new Error('Production VITE_API_BASE_URL must use HTTPS and must not contain credentials.');
        connectSources.push(apiUrl.origin);
      }
      const policy = [
        "default-src 'self'", "base-uri 'self'", "object-src 'none'",
        "form-action 'self'", "img-src 'self' data:", "font-src 'self' data:",
        "script-src 'self'", "style-src 'self' 'unsafe-inline'", `connect-src ${connectSources.join(' ')}`
      ].join('; ');
      const tag = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}">`;
      return html.replace('</head>', `${tag}</head>`);
    }
  };
}

export default defineConfig(({ mode }) => {
  const viteEnv = loadEnv(mode, process.cwd(), 'VITE_');
  return { plugins: [react(), dashboardSecurityHeaders(viteEnv.VITE_API_BASE_URL)], server: { port: 5173, strictPort: true } };
});

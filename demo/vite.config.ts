import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const values = loadEnv(mode, '..', '');
  const apiBase = values.VITE_API_BASE_URL || process.env.VITE_API_BASE_URL || 'http://localhost:4000';
  return {
    envDir: '..',
    plugins: [{
      name: 'replace-demo-api-url',
      transformIndexHtml: {
        order: 'pre',
        handler(html: string) { return html.replaceAll('__MEDIASSIST_API_BASE_URL__', apiBase); }
      }
    }],
    server: { port: 5174, strictPort: true }
  };
});

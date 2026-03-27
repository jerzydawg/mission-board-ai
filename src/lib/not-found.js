const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => {
  switch (char) {
    case '&':
      return '&amp;';
    case '<':
      return '&lt;';
    case '>':
      return '&gt;';
    case '"':
      return '&quot;';
    case '\'':
      return '&#39;';
    default:
      return char;
  }
});

export function renderNotFoundPage(pathname = '') {
  const safePath = escapeHtml(pathname);
  const title = '404 - Page Not Found | MrDelegate';
  const description = 'The page you requested does not exist. Return home or start your free trial.';

  return `<!DOCTYPE html>
<html lang="en" style="color-scheme:light;background:#FFFDF9">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="${description}">
  <meta name="robots" content="noindex,nofollow">
  <style>
    :root {
      --bg: #FFFDF9;
      --bg-warm: #FCF9F4;
      --bg-deep: #F7F2EB;
      --surface-warm: rgba(251,248,243,0.95);
      --border: rgba(223,208,191,0.9);
      --text: #1A1A1A;
      --muted: #8A7B6D;
      --accent: #F76707;
      --accent-dark: #E8590C;
    }

    * { box-sizing: border-box; }

    html, body { margin: 0; min-height: 100%; }

    body {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 32px 20px;
      overflow: hidden;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(247,103,7,0.12), transparent 28%),
        radial-gradient(circle at bottom right, rgba(203,108,50,0.14), transparent 24%),
        linear-gradient(180deg, var(--bg) 0%, var(--bg-warm) 52%, var(--bg-deep) 100%);
    }

    .card {
      width: min(100%, 720px);
      padding: 56px 40px;
      border-radius: 28px;
      border: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255,255,255,0.82) 0%, var(--surface-warm) 100%);
      box-shadow: 0 32px 80px -56px rgba(62,36,7,0.34), inset 0 1px 0 rgba(255,255,255,0.85);
      text-align: center;
    }

    .wordmark {
      display: inline-flex;
      align-items: center;
      text-decoration: none;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      color: var(--text);
      font-size: 18px;
    }

    .wordmark-mr {
      font-weight: 900;
      letter-spacing: 0.14em;
    }

    .wordmark-sep {
      width: 5px;
      height: 5px;
      margin: 0 9px;
      border-radius: 999px;
      background: rgba(26,26,26,0.35);
      flex-shrink: 0;
    }

    .wordmark-delegate {
      font-weight: 400;
      letter-spacing: 0.22em;
    }

    .code {
      margin: 18px 0 8px;
      font-size: clamp(88px, 18vw, 180px);
      line-height: 0.9;
      font-weight: 800;
      letter-spacing: -0.06em;
    }

    h1 {
      margin: 0;
      font-family: "Instrument Serif", Georgia, serif;
      font-size: clamp(42px, 7vw, 68px);
      font-weight: 400;
      letter-spacing: -0.045em;
      line-height: 0.95;
    }

    p {
      margin: 16px auto 0;
      max-width: 34ch;
      font-size: 17px;
      line-height: 1.7;
      color: var(--muted);
    }

    .path {
      margin-top: 12px;
      font-size: 13px;
      line-height: 1.5;
      color: #A89B90;
      word-break: break-word;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
      margin-top: 28px;
    }

    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 190px;
      padding: 12px 24px;
      border-radius: 10px;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, border-color 0.15s ease;
    }

    .button-primary {
      color: #fff;
      background: linear-gradient(180deg, var(--accent) 0%, var(--accent-dark) 100%);
      box-shadow: 0 0 0 1px #D9480F, 0 1px 2px rgba(217,72,15,0.4), 0 4px 12px rgba(217,72,15,0.2), inset 0 1px rgba(255,255,255,0.25);
    }

    .button-primary:hover {
      transform: translateY(-1px);
    }

    .button-secondary {
      color: #3D3D3D;
      border: 1px solid #ECE2D8;
      background: rgba(255,255,255,0.55);
    }

    .button-secondary:hover {
      border-color: #DFD0BF;
      background: rgba(247,244,239,0.9);
    }

    @media (max-width: 640px) {
      body {
        padding: 20px 16px;
      }

      .card {
        padding: 40px 22px 28px;
        border-radius: 22px;
      }

      .wordmark {
        font-size: 15px;
      }

      .actions {
        width: 100%;
      }

      .button {
        width: 100%;
        min-width: 0;
      }
    }
  </style>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
</head>
<body>
  <main class="card">
    <a href="/" class="wordmark" aria-label="MrDelegate home">
      <span class="wordmark-mr">MR</span>
      <span class="wordmark-sep"></span>
      <span class="wordmark-delegate">DELEGATE</span>
    </a>
    <div class="code">404</div>
    <h1>Page not found</h1>
    <p>The page you were looking for moved, expired, or never existed.</p>
    ${safePath ? `<div class="path">${safePath}</div>` : ''}
    <div class="actions">
      <a class="button button-secondary" href="/">Go Home →</a>
      <a class="button button-primary" href="/pricing">Start Free Trial →</a>
    </div>
  </main>
</body>
</html>`;
}

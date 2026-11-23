import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';

const PORT = Number(process.env.PORT || 3000);
const PYTHON_PORT = Number(process.env.FTREE_PORT || 8001);
const PYTHON_HOST = '127.0.0.1';
const DATA_DIR = path.resolve(process.cwd(), 'data', 'workspace');

function startPythonBackend(): ChildProcess {
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(
    pythonBin,
    ['-m', 'backend.server', '--host', PYTHON_HOST, '--port', String(PYTHON_PORT), '--data-dir', DATA_DIR],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    },
  );

  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT') {
      console.error(`Python backend exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  return child;
}

async function waitForPythonHealth(pyProc: ChildProcess, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (pyProc.exitCode !== null) {
      throw new Error(`Python backend exited early during startup (code=${pyProc.exitCode})`);
    }
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const req = http.get(
          { hostname: PYTHON_HOST, port: PYTHON_PORT, path: '/api/health', timeout: 800 },
          (res) => {
            res.resume();
            resolve(res.statusCode === 200);
          },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Python backend failed to become healthy within timeout');
}

function proxyToPython(req: express.Request, res: express.Response): void {
  const targetReq = http.request(
    {
      hostname: PYTHON_HOST,
      port: PYTHON_PORT,
      path: req.originalUrl,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${PYTHON_HOST}:${PYTHON_PORT}`,
      },
    },
    (targetRes) => {
      res.writeHead(targetRes.statusCode || 502, targetRes.headers);
      targetRes.pipe(res, { end: true });
    },
  );

  targetReq.on('error', (err) => {
    console.error('Proxy error to Python backend:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          code: 'backend_unavailable',
          message: 'A Python adatkezelő backend jelenleg nem elérhető.',
        },
      });
    }
  });

  req.pipe(targetReq, { end: true });
}

async function main(): Promise<void> {
  const pyProc = startPythonBackend();

  const cleanupPython = () => {
    if (pyProc.exitCode === null && !pyProc.killed) {
      pyProc.kill('SIGTERM');
    }
  };
  const shutdown = () => {
    cleanupPython();
    process.exit(0);
  };
  process.on('exit', cleanupPython);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await waitForPythonHealth(pyProc);

  const app = express();

  // Stream /api/* and /media/* directly to the Python backend (supports JSON, multipart, binary .ftree)
  app.use('/api', proxyToPython);
  app.use('/media', proxyToPython);

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Családfa web app listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

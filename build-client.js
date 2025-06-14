const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  try {
    // Find all .ts and .tsx files in src/client, excluding apiClient.ts which is a shared module
    const clientDir = 'src/client';
    const files = fs.readdirSync(clientDir);
    const entryPoints = files
      .filter(file => (file.endsWith('.ts') || file.endsWith('.tsx')) && file !== 'apiClient.ts')
      .map(file => path.join(clientDir, file));

    if (entryPoints.length === 0) {
      console.log('No TypeScript entry point files found in src/client');
      return;
    }

    console.log('Building client files:', entryPoints);

    await esbuild.build({
      entryPoints,
      bundle: true,
      outdir: 'public/js',
      format: 'iife',
      target: 'es2020',
      jsx: 'transform',
      jsxFactory: 'jsx',
      jsxFragment: 'Fragment',
      define: {
        'process.env.NODE_ENV': '"production"'
      },
      minify: true,
      sourcemap: true,
    });

    console.log('Client scripts built successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
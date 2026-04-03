import webpack from 'webpack';
import TerserPlugin from 'terser-webpack-plugin';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.NODE_ENV || 'production';

const externals = {
  'promised-sqlite3': { import: 'promised-sqlite3' },
  'puppeteer': { import: 'puppeteer' },
  'sqlite3': { import: 'sqlite3' },
};

const rootPkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const allDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };

const dependencies = Object.fromEntries(
  Object.keys(externals).map(name => [name, allDeps[name] ?? '*'])
);

const emitPackageJson = content => ({
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('EmitPackageJson', compilation => {
      compilation.hooks.processAssets.tap(
        { name: 'EmitPackageJson', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          const json = JSON.stringify(content, null, 2);
          compilation.emitAsset('package.json', new webpack.sources.RawSource(json));
        }
      );
    });
  }
});

export default {
  mode,
  entry: './src/app.ts',
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'app.js',
    module: true,          // emit ES module syntax
    chunkFormat: 'module', // chunks use import() instead of require()
    library: {
      type: 'module',      // output as ESM
    }
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  experiments: {
    outputModule: true,    // required to enable ESM output
  },
  resolve: {
    extensions: ['.ts', '.js'],
    mainFields: ['module', 'main'],
    extensionAlias: {
      '.js': ['.ts', '.js'], // when .js is requested, also try .ts
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: [
          'ts-loader',
        ]
      }
    ]
  },
  optimization: {
    concatenateModules: false,
    minimize: mode === 'production',
    minimizer: [new TerserPlugin({
      terserOptions: {
        output: { max_line_len: 511 }
      }
    })],
  },
  devtool: 'source-map',
  plugins: [
    new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true }),
    emitPackageJson({
      type: 'module', dependencies,
      scripts: {
        debug: 'node --env-file=.env --inspect=0.0.0.0:9229 app.js'
      },
      overrides: {
        'promised-sqlite3': {
          sqlite3: '$sqlite3'
        }
      }
    })
  ],
  externals: [
    ({ request }, callback) => {
      const esm = Object.keys(externals);
      if (esm.includes(request))
        return callback(null, `module ${request}`);
      callback();
    }
  ]
};

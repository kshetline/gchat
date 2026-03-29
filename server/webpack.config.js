import webpack from 'webpack';
import TerserPlugin from 'terser-webpack-plugin';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mode = process.env.NODE_ENV || 'production';

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
    new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true })
  ],
  externals: [
    ({ request }, callback) => {
      const esm = ['promised-sqlite3', 'puppeteer', 'sqlite3'];
      if (esm.includes(request))
        return callback(null, `module ${request}`);
      callback();
    }
  ]
};

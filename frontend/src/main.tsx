// フロントエンドのエントリ。
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/index.css'; // デザイントークンと全体の基本スタイル（最初に読み込む）
import { App } from './App.js';
import { SessionProvider } from './store/session.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root が見つかりません。');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <App />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);

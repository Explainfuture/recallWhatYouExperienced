/// <reference types="vite/client" />
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { startMcpBridge } from './lib/mcpBridge';
import './styles.css';

const stopMcpBridge = startMcpBridge();
if (import.meta.hot) import.meta.hot.dispose(() => { void stopMcpBridge().catch(() => {}); });

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

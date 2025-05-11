import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App'; // We will create App.tsx next
import './globals.css';

// JetBrains Mono font is now linked in index.html, but we still need to define the CSS variable
// if tailwind.config.ts or globals.css expects it. For now, ensuring globals.css is imported.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
); 
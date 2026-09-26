import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import 'bootstrap/dist/css/bootstrap.min.css';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
if (import.meta.env.MODE === 'development') {
  const originalWarn = console.warn;

  // Override console.warn to filter out the specific React Router warnings
  console.warn = (...args) => {
    if (
      args[0] &&
      (args[0].includes('React Router Future Flag Warning: React Router will begin wrapping state updates in `React.startTransition`') ||
        args[0].includes('React Router Future Flag Warning: Relative route resolution within Splat routes is changing in v7'))
    ) {
      return; // Ignore these specific warnings
    }
    originalWarn(...args); // Call the original console.warn if the warning is not from React Router
  };
}

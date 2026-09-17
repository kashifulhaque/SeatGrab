import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { redirectLegacyHashRoute } from './app/routes';
import './app.css';

// Before the first render, so a bookmark from the version that addressed screens by
// fragment opens the screen it names rather than the home screen.
redirectLegacyHashRoute();

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing its #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

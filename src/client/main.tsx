import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/bricolage-grotesque';
import { App } from './App.js';
import { VisualAuditApp } from './VisualAudit.js';
import './styles.css';

const visualAudit = import.meta.env.DEV && window.location.pathname === '/__visual-audit';
const application = visualAudit ? <VisualAuditApp /> : <App />;

// The visual harness measures the same interaction work as production. React's
// development-only StrictMode intentionally invokes state updaters twice, which
// would otherwise turn its frame samples into measurements of the test runtime.
createRoot(document.getElementById('root')!).render(visualAudit ? application : <StrictMode>{application}</StrictMode>);

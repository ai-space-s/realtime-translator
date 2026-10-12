import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { CaptionView } from './CaptionView';
import './styles.css';

const audience = new URLSearchParams(location.search).get('view') === 'caption';
createRoot(document.getElementById('root')!).render(<React.StrictMode>{audience ? <CaptionView/> : <App/>}</React.StrictMode>);

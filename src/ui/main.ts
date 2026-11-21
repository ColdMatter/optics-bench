import '../styles.css';
import { createApp } from './app';
import { defaultSetup } from './defaultSetup';
import { createStore, loadAutosave } from './store';

const root = document.getElementById('app');
if (!root) throw new Error('index.html has no #app element');
createApp(root, createStore(loadAutosave() ?? defaultSetup()));

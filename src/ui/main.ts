import '../styles.css';
import { createApp, showMessage } from './app';
import { defaultSetup } from './defaultSetup';
import { createStore, readAutosave } from './store';

const root = document.getElementById('app');
if (!root) throw new Error('index.html has no #app element');
const saved = readAutosave();
createApp(root, createStore(saved && 'setup' in saved ? saved.setup : defaultSetup()));
if (saved && 'error' in saved) {
  showMessage(
    'Autosaved setup not loaded',
    `Your autosaved setup could not be loaded: ${saved.error}. The default setup was opened; ` +
      'the unreadable copy is kept in browser storage.',
  );
}

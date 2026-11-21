import '../styles.css';
import { createApp, showMessage } from './app';
import { openCatalogue } from './catalogue';
import { defaultSetup } from './defaultSetup';
import { renderReadouts } from './readouts';
import { createSolverPanel } from './solverPanel';
import { createStore, readAutosave } from './store';

const root = document.getElementById('app');
if (!root) throw new Error('index.html has no #app element');
const saved = readAutosave();
const app = createApp(root, createStore(saved && 'setup' in saved ? saved.setup : defaultSetup()));
const solver = createSolverPanel(app.solverEl, app.store);
app.onFrame(({ state, trace, gaussians }) => {
  renderReadouts(app.readoutsEl, state, trace, gaussians);
  solver.render(state);
});
app.setCatalogueAction(() => openCatalogue(app.store));
if (saved && 'error' in saved) {
  showMessage(
    'Autosaved setup not loaded',
    `Your autosaved setup could not be loaded: ${saved.error}. The default setup was opened; ` +
      'the unreadable copy is kept in browser storage.',
  );
}

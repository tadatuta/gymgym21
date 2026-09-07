import './components/typeahead/typeahead.css';
import './styles/base.css';
import './styles/components.css';
import './styles/profile.css';
import './components/navigation/navigation.css';
import './styles/stats.css';
import { registerSW } from 'virtual:pwa-register';
import { createApplication } from './ui/application';

registerSW({ immediate: true });
const application = createApplication();
void application.mount();
if (import.meta.hot) import.meta.hot.dispose(() => application.dispose());

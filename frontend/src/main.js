import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';
import { bootstrapAccessTokenFromUrl, setAccessToken } from './lib/apiClient';

bootstrapAccessTokenFromUrl();

if (typeof window !== 'undefined' && window.__SIMPLESTOCK_ACCESS_TOKEN__) {
  setAccessToken(window.__SIMPLESTOCK_ACCESS_TOKEN__);
}

createApp(App).mount('#app');

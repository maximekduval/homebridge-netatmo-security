import axios from 'axios';
import fs from 'fs';
import path from 'path';

// Netatmo deprecated the password grant (Resource Owner Password Credentials),
// so we authenticate exclusively with the OAuth2 refresh-token flow:
//  - the user generates a refresh token once on dev.netatmo.com and sets it in
//    the config (first run only);
//  - Netatmo rotates the refresh token on every refresh, so we persist the latest
//    one to disk and always prefer it over the (now possibly stale) config value.
export default class NetatmoAPI {
  log = null;
  config = null;
  storagePath = null;
  accessToken = null;
  refreshToken = null;
  tokenExpire = 0;
  _authPromise = null;

  constructor(logger, storagePath) {
    this.log = logger;
    this.storagePath = storagePath;
    this.log.info('Netatmo API constructed.');
  }

  get tokenFile() {
    return path.join(this.storagePath || '.', 'netatmo-security-token.json');
  }

  loadPersistedRefreshToken() {
    try {
      if (this.storagePath && fs.existsSync(this.tokenFile)) {
        const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        if (data && data.refresh_token) {
          this.log.debug('Loaded persisted refresh token.');
          return data.refresh_token;
        }
      }
    } catch (error) {
      this.log.warn('Could not read persisted token: ' + error.message);
    }
    return null;
  }

  persistRefreshToken() {
    try {
      if (this.storagePath && this.refreshToken) {
        fs.writeFileSync(this.tokenFile, JSON.stringify({ refresh_token: this.refreshToken }), { mode: 0o600 });
      }
    } catch (error) {
      this.log.warn('Could not persist token: ' + error.message);
    }
  }

  async init(configuration) {
    this.config = configuration;
    // Prefer the rotated token we persisted; fall back to the config one (first run).
    this.refreshToken = this.loadPersistedRefreshToken() || configuration.refresh_token || null;
    if (!this.refreshToken) {
      throw new Error(
        'No refresh token available. Generate one with the token generator on your app at '
        + 'dev.netatmo.com (scope read_camera) and set "refresh_token" in the plugin config.');
    }
    await this.authenticate();
    this.log.debug('Netatmo API loaded.');
  }

  async authenticate() {
    if (!this.refreshToken) {
      throw new Error('Missing refresh token; cannot authenticate.');
    }
    // Netatmo's token endpoint expects application/x-www-form-urlencoded, NOT
    // multipart/form-data — sending multipart makes it reject the request with
    // {"error":"invalid_client"}.
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', this.refreshToken);
    params.append('client_id', this.config.client_id);
    params.append('client_secret', this.config.client_secret);

    let response;
    try {
      response = await axios.post('https://api.netatmo.com/oauth2/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch (error) {
      const detail = error.response ? JSON.stringify(error.response.data) : error.message;
      this.log.error('Netatmo authentication failed: ' + detail);
      throw error;
    }

    const data = response.data;
    this.accessToken = data.access_token;
    // Netatmo rotates the refresh token on every refresh — keep and persist the new one.
    if (data.refresh_token && data.refresh_token !== this.refreshToken) {
      this.refreshToken = data.refresh_token;
      this.persistRefreshToken();
    }
    // Refresh a few minutes before the real expiry (expires_in is seconds, ~3h).
    const expiresIn = data.expires_in ? Number(data.expires_in) : 10800;
    this.tokenExpire = (Date.now() / 1000) + expiresIn - 300;
    this.log.debug('Authentication complete; token valid ~' + Math.round(expiresIn / 60) + ' min.');
  }

  // Ensure a valid access token before any request. A single in-flight refresh is
  // shared across concurrent callers so we never fire a storm of token requests.
  async ensureAuth() {
    const time = Date.now() / 1000;
    if (this.accessToken && time < this.tokenExpire) {
      return;
    }
    if (!this._authPromise) {
      this.log.info('Refreshing Netatmo authentication token...');
      this._authPromise = this.authenticate().finally(() => {
        this._authPromise = null;
      });
    }
    return this._authPromise;
  }

  client() {
    return axios.create({
      baseURL: 'https://api.netatmo.com/api/',
      responseType: 'json',
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
  }

  async setState(device, status) {
    await this.ensureAuth();
    const body = { home: {
      id: device.home_id,
      modules: [
        {
          id: device.id,
          status: status,
          bridge: device.bridge,
        },
      ],
    }};
    this.log.debug('Set State request: ' + JSON.stringify(body));
    const response = await this.client().post('/setstate', body);
    const data = response.data;
    this.log.debug('Set State response: ' + JSON.stringify(response.data));
    return data;
  }

  async getEvents(homeId) {
    await this.ensureAuth();
    const response = await this.client().get('/getevents?home_id=' + homeId);
    const data = response.data.body.home;
    const events = data.events;
    return events;
  }

  async getHomeData() {
    await this.ensureAuth();
    const response = await this.client().get('/homesdata');
    const data = response.data.body;
    const home = data.homes[0];
    return home;
  }

  async getHomeStatus(homeId) {
    await this.ensureAuth();
    const response = await this.client().get('/homestatus?home_id=' + homeId);
    const data = response.data.body;
    const status = data.home;
    return status;
  }

  async getHomeDevices() {
    const home = await this.getHomeData();
    const status = await this.getHomeStatus(home.id);
    const events = await this.getEvents(home.id);
    const devices = [];
    home.modules.map((moduleInfo) => {
      const moduleStatus = status.modules.find((module) => moduleInfo.id === module.id);
      const minimumTime = (new Date().getTime() / 1000) - 90;
      const moduleEvents = events.filter((event) => moduleInfo.id === event.module_id && event.time > minimumTime);
      const lastActivity = moduleEvents.length > 0 ? Math.max.apply(Math, moduleEvents.map((event) => event.time)) : 0;
      const device = { ...moduleStatus,
        name: moduleInfo.name,
        category: moduleInfo.category,
        setup_date: moduleInfo.setup_date,
        room_id: moduleInfo.room_id,
        home_id: home.id,
        activity: lastActivity,
      };
      devices.push(device);
    });
    return devices;
  }

}

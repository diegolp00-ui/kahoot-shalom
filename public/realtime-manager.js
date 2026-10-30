/**
 * RealtimeManager: Capa de transporte en tiempo real para Kahoot Shalom 2026
 * Utiliza MQTT sobre WebSockets Seguros (WSS) mediante un broker público en la nube (EMQX WSS).
 * - 100% GRATIS, sin registrar cuentas, sin tarjetas de crédito y sin planes PRO.
 * - Conexión instantánea y cifrada (TLS).
 * - Soporta reconexión automática y fallback a BroadcastChannel para pruebas locales.
 */
class ShalomRealtime {
  constructor() {
    this.brokerHost = 'broker.emqx.io';
    this.brokerPort = 8084; // Puerto seguro WSS
    this.brokerPath = '/mqtt';
    this.pahoClient = null;
    this.bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('shalom_kahoot_realtime') : null;
    this.isHost = false;
    this.currentPin = '';
    this.onStatus = null;
    this.isConnected = false;
  }

  // Helper para generar ID único de cliente
  generateClientId(prefix = 'client') {
    return prefix + '_' + Math.random().toString(36).slice(2, 9) + '_' + Date.now().toString(36);
  }

  // ================= PANEL ANFITRIÓN =================
  initHost(pin, onPlayerAction, onStatusChange) {
    this.isHost = true;
    this.currentPin = String(pin).trim();
    this.onStatus = onStatusChange || (() => {});

    // 1. Escucha en BroadcastChannel local (pruebas en misma máquina)
    if (this.bc) {
      this.bc.onmessage = (ev) => {
        const { type, payload } = ev.data || {};
        if (type === 'player_action' && payload && payload.pin === this.currentPin) {
          onPlayerAction(payload);
        }
      };
    }

    // 2. Conecta a la Nube WSS (Paho MQTT)
    if (typeof Paho !== 'undefined' && Paho.Client) {
      if (this.pahoClient) {
        try { this.pahoClient.disconnect(); } catch (e) {}
      }

      this.onStatus('connecting', 'Conectando a la nube en tiempo real...');
      const clientId = this.generateClientId('host_' + this.currentPin);
      this.pahoClient = new Paho.Client(this.brokerHost, this.brokerPort, this.brokerPath, clientId);

      this.pahoClient.onConnectionLost = (responseObject) => {
        this.isConnected = false;
        if (responseObject.errorCode !== 0) {
          this.onStatus('warning', '⚠️ Reconectando con la nube...');
        }
      };

      this.pahoClient.onMessageArrived = (message) => {
        try {
          const data = JSON.parse(message.payloadString);
          if (data && data.pin === this.currentPin) {
            onPlayerAction(data);
          }
        } catch (e) {
          console.warn('Error procesando mensaje:', e);
        }
      };

      const actionTopic = `shalom2026/room_${this.currentPin}/actions`;
      this.pahoClient.connect({
        useSSL: true,
        timeout: 6,
        keepAliveInterval: 30,
        cleanSession: true,
        reconnect: true,
        onSuccess: () => {
          this.isConnected = true;
          this.pahoClient.subscribe(actionTopic, { qos: 0 });
          this.onStatus('connected', '🌐 Conectado a la nube (Tiempo Real Activo)');
        },
        onFailure: (err) => {
          console.warn('MQTT Connection failure:', err);
          this.isConnected = false;
          this.onStatus('local', '⚡ Modo local activo (reintentando nube...)');
        }
      });
    } else {
      this.onStatus('local', '⚡ Modo local activo');
    }
  }

  hostBroadcastState(state) {
    this._sendMqtt(`shalom2026/room_${this.currentPin}/state`, { event: 'room_state', payload: state });
    if (this.bc) {
      this.bc.postMessage({ type: 'room_state', payload: state });
    }
  }

  hostBroadcastTick(tickData) {
    this._sendMqtt(`shalom2026/room_${this.currentPin}/tick`, { event: 'room_tick', payload: tickData });
    if (this.bc) {
      this.bc.postMessage({ type: 'room_tick', payload: tickData });
    }
  }

  hostBroadcastResult(resultData) {
    this._sendMqtt(`shalom2026/room_${this.currentPin}/result`, { event: 'question_result', payload: resultData });
    if (this.bc) {
      this.bc.postMessage({ type: 'question_result', payload: resultData });
    }
  }

  // ================= JUGADOR / CELULAR =================
  initPlayer(pin, playerId, name, dni, callbacks) {
    this.isHost = false;
    this.currentPin = String(pin).trim();
    const { onRoomState, onRoomTick, onQuestionResult, onStatusChange } = callbacks;
    this.onStatus = onStatusChange || (() => {});

    // 1. Escucha en BroadcastChannel local
    if (this.bc) {
      this.bc.onmessage = (ev) => {
        const { type, payload } = ev.data || {};
        if (type === 'room_state' && payload && payload.pin === this.currentPin) {
          onRoomState(payload);
        } else if (type === 'room_tick') {
          onRoomTick(payload);
        } else if (type === 'question_result' && payload && payload.playerId === playerId) {
          onQuestionResult(payload);
        }
      };
    }

    // 2. Conecta a la Nube WSS (Paho MQTT)
    if (typeof Paho !== 'undefined' && Paho.Client) {
      if (this.pahoClient) {
        try { this.pahoClient.disconnect(); } catch (e) {}
      }

      this.onStatus('connecting', 'Conectando a la sala...');
      const clientId = this.generateClientId('player_' + playerId);
      this.pahoClient = new Paho.Client(this.brokerHost, this.brokerPort, this.brokerPath, clientId);

      this.pahoClient.onConnectionLost = (responseObject) => {
        this.isConnected = false;
        if (responseObject.errorCode !== 0) {
          this.onStatus('warning', '⚠️ Reconectando...');
        }
      };

      this.pahoClient.onMessageArrived = (message) => {
        try {
          const data = JSON.parse(message.payloadString);
          const { event, payload } = data || {};
          if (event === 'room_state' && payload && payload.pin === this.currentPin) {
            onRoomState(payload);
          } else if (event === 'room_tick') {
            onRoomTick(payload);
          } else if (event === 'question_result' && payload && payload.playerId === playerId) {
            onQuestionResult(payload);
          }
        } catch (e) {
          console.warn('Error parseando mensaje:', e);
        }
      };

      const roomPrefix = `shalom2026/room_${this.currentPin}/`;
      this.pahoClient.connect({
        useSSL: true,
        timeout: 6,
        keepAliveInterval: 30,
        cleanSession: true,
        reconnect: true,
        onSuccess: () => {
          this.isConnected = true;
          this.pahoClient.subscribe(`${roomPrefix}#`, { qos: 0 });
          this.onStatus('connected', '🟢 Conectado a la sala');
          this.playerSendJoin(this.currentPin, playerId, name, dni);
        },
        onFailure: () => {
          this.isConnected = false;
          this.onStatus('local', '⚡ Modo local');
          this.playerSendJoin(this.currentPin, playerId, name, dni);
        }
      });
    } else {
      this.onStatus('local', '⚡ Modo local');
      this.playerSendJoin(this.currentPin, playerId, name, dni);
    }
  }

  playerSendJoin(pin, playerId, name, dni) {
    const payload = {
      action: 'join',
      pin: String(pin).trim(),
      playerId,
      name,
      dni,
      timestamp: Date.now()
    };
    this._sendMqtt(`shalom2026/room_${pin}/actions`, payload);
    if (this.bc) {
      this.bc.postMessage({ type: 'player_action', payload });
    }
  }

  playerSendAnswer(pin, playerId, optionIndex) {
    const payload = {
      action: 'answer',
      pin: String(pin).trim(),
      playerId,
      optionIndex: Number(optionIndex),
      timestamp: Date.now()
    };
    this._sendMqtt(`shalom2026/room_${pin}/actions`, payload);
    if (this.bc) {
      this.bc.postMessage({ type: 'player_action', payload });
    }
  }

  _sendMqtt(topic, data) {
    if (this.pahoClient && this.isConnected) {
      try {
        const msg = new Paho.Message(JSON.stringify(data));
        msg.destinationName = topic;
        msg.qos = 0;
        this.pahoClient.send(msg);
      } catch (e) {
        console.warn('MQTT send error:', e);
      }
    }
  }
}

window.shalomRealtime = new ShalomRealtime();

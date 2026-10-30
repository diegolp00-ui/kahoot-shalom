/**
 * RealtimeManager: Capa de transporte en tiempo real para Kahoot Shalom
 * Soporta Supabase Realtime Broadcast (para multijugador por Internet / Vercel)
 * y BroadcastChannel (para pruebas locales y fallback instantáneo).
 */
class ShalomRealtime {
  constructor() {
    this.client = null;
    this.channel = null;
    this.bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('shalom_kahoot_realtime') : null;
    this.isHost = false;
    this.currentPin = '';
    this.onStatus = null;
    this.initSupabaseClient();
  }

  initSupabaseClient() {
    const config = window.SHALOM_CONFIG;
    if (config && config.hasSupabase() && window.supabase && typeof window.supabase.createClient === 'function') {
      try {
        this.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
          realtime: {
            params: {
              eventsPerSecond: 20
            }
          }
        });
      } catch (err) {
        console.warn('Error inicializando cliente Supabase:', err);
        this.client = null;
      }
    }
  }

  hasCloudRealtime() {
    return Boolean(this.client);
  }

  // ================= PANEL ANFITRIÓN =================
  initHost(pin, onPlayerAction, onStatusChange) {
    this.isHost = true;
    this.currentPin = String(pin).trim();
    this.onStatus = onStatusChange || (() => {});

    // 1. Escucha en BroadcastChannel local
    if (this.bc) {
      this.bc.onmessage = (ev) => {
        const { type, payload } = ev.data || {};
        if (type === 'player_action' && payload && payload.pin === this.currentPin) {
          onPlayerAction(payload);
        }
      };
    }

    // 2. Conecta a Supabase Realtime Broadcast
    if (this.client) {
      if (this.channel) {
        this.client.removeChannel(this.channel);
      }

      this.onStatus('connecting', 'Conectando con Supabase Cloud...');

      this.channel = this.client.channel(`room_${this.currentPin}`, {
        config: {
          broadcast: { self: false }
        }
      });

      this.channel
        .on('broadcast', { event: 'player_action' }, ({ payload }) => {
          if (payload && payload.pin === this.currentPin) {
            onPlayerAction(payload);
          }
        })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            this.onStatus('connected', '🌐 Conectado a la nube (Supabase Realtime)');
          } else if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') {
            this.onStatus('warning', '⚠️ Error en canal en la nube. Reintentando...');
          } else if (status === 'CLOSED') {
            this.onStatus('offline', '🔴 Desconectado de la nube');
          }
        });
    } else {
      this.onStatus('local', '⚡ Modo local activo (esperando configuración de Supabase para nube)');
    }
  }

  hostBroadcastState(state) {
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'room_state',
        payload: state
      }).catch(e => console.warn('Broadcast state error:', e));
    }
    if (this.bc) {
      this.bc.postMessage({ type: 'room_state', payload: state });
    }
  }

  hostBroadcastTick(tickData) {
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'room_tick',
        payload: tickData
      }).catch(() => {});
    }
    if (this.bc) {
      this.bc.postMessage({ type: 'room_tick', payload: tickData });
    }
  }

  hostBroadcastResult(resultData) {
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'question_result',
        payload: resultData
      }).catch(() => {});
    }
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

    // 2. Conecta a Supabase Realtime
    if (this.client) {
      if (this.channel) {
        this.client.removeChannel(this.channel);
      }

      this.onStatus('connecting', 'Conectando con la sala...');

      this.channel = this.client.channel(`room_${this.currentPin}`, {
        config: {
          broadcast: { self: false }
        }
      });

      this.channel
        .on('broadcast', { event: 'room_state' }, ({ payload }) => {
          if (payload && payload.pin === this.currentPin) {
            onRoomState(payload);
          }
        })
        .on('broadcast', { event: 'room_tick' }, ({ payload }) => {
          onRoomTick(payload);
        })
        .on('broadcast', { event: 'question_result' }, ({ payload }) => {
          if (payload && payload.playerId === playerId) {
            onQuestionResult(payload);
          }
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.onStatus('connected', '🟢 Conectado');
            this.playerSendJoin(this.currentPin, playerId, name, dni);
          } else if (status === 'TIMED_OUT' || status === 'CHANNEL_ERROR') {
            this.onStatus('warning', '⚠️ Reconectando...');
          }
        });
    } else {
      this.onStatus('local', '⚡ Modo local');
      // Enviar join local inmediatamente
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
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'player_action',
        payload
      }).catch(() => {});
    }
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
    if (this.channel) {
      this.channel.send({
        type: 'broadcast',
        event: 'player_action',
        payload
      }).catch(() => {});
    }
    if (this.bc) {
      this.bc.postMessage({ type: 'player_action', payload });
    }
  }
}

window.shalomRealtime = new ShalomRealtime();

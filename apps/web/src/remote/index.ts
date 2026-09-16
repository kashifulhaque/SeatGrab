/**
 * Online transport: one seat's authorized projection, over a connection that reopens.
 *
 * Import from here rather than from the individual modules, as with `../local`.
 */
export {
  DEFAULT_BACKOFF_MS,
  RemoteConnection,
  socketUrl,
  type CancelTimer,
  type ConnectionStatus,
  type RemoteConnectionOptions,
  type RemoteSocket,
  type RemoteSocketFactory,
  type Scheduler,
  type SocketHandlers,
} from './socket';
export {
  ONLINE_MODE_NOTICE,
  openRemoteMatch,
  type RemoteMatch,
  type RemoteMatchOptions,
} from './remoteMatch';
export {
  RoomRequestError,
  claimSeat,
  createRoom,
  foldRoomCode,
  readLobby,
  releaseSeat,
  startMatch,
  type ClaimedSeat,
  type LobbySeatView,
  type LobbyView,
  type RoomClientOptions,
} from './rooms';
export {
  SEAT_STORE_KEY,
  openSeatStore,
  storedSeatFrom,
  type OpenSeatStore,
  type SeatStorage,
  type SeatStore,
  type StoredSeat,
} from './seatStore';

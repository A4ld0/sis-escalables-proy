import Redis from 'ioredis';
import { all, ttl, user } from './data';

const endpoint = process.env.PRESENCE_HOST;
const redis = endpoint ? new Redis({
  host:endpoint, port:6379, tls:{}, lazyConnect:true, enableOfflineQueue:false,
  connectTimeout:700, maxRetriesPerRequest:0, retryStrategy:attempt=>Math.min(attempt*100,1000),
}) : undefined;
redis?.on('error', error => console.warn({event:'presence_cache_error',name:error.name}));
async function cache<T>(work: (connection: Redis) => Promise<T>) {
  if (!redis) return undefined;
  try {
    if (redis.status === 'wait') await redis.connect();
    if (redis.status !== 'ready') return undefined;
    return await work(redis);
  } catch { return undefined; }
}
const key = (uid: string) => 'presence:'+uid;
export async function setPresence(uid: string, id: string, expires: number) {
  await cache(connection => connection.multi()
    .zremrangebyscore(key(uid),'-inf',ttl(0))
    .zadd(key(uid),Math.min(expires,ttl(60)),id)
    .expire(key(uid),60).exec());
}
export async function clearPresence(uid: string, id: string) {
  await cache(connection => connection.zrem(key(uid),id));
}
export async function isOnline(uid: string) {
  const count = await cache(connection => connection.zcount(key(uid),ttl(1),'+inf'));
  if (count !== undefined) return count > 0;
  for await (const conn of all(user(uid),'CONN#')) {
    if (conn.ttl > ttl(0) && conn.tokenExp > ttl(0)) return true;
  }
  return false;
}
export async function canType(uid: string) {
  return cache(connection => connection.set('typing:'+uid,'1','EX',3,'NX'));
}

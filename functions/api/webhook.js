export async function onRequest(context) {
  const { request, env } = context
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 })

  const workerUrl = env.WORKER_URL || 'https://your-worker.your-subdomain.workers.dev'
  const response = await fetch(`${workerUrl}/webhook`, {
    method: 'POST',
    headers: request.headers,
    body: request.body,
  })
  return response
}

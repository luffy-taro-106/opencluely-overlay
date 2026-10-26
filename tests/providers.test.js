'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRequest, parseSSE, streamAnswer, validateApiKey } = require('../overlay/providers');
const encoder = new TextEncoder();
const frame = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
function response(text, chunkSize = 7) { return new Response(new ReadableStream({ start(controller) { const bytes = encoder.encode(text); for (let i=0;i<bytes.length;i+=chunkSize) controller.enqueue(bytes.slice(i,i+chunkSize)); controller.close(); } }), { status:200 }); }
const anthropicStream = text => frame({ type:'content_block_delta',delta:{type:'text_delta',text} }) + frame({type:'message_delta',delta:{stop_reason:'end_turn'}}) + frame({type:'message_stop'});
const options = { provider:'anthropic', model:'claude-sonnet-5-5', apiKey:'test-key-not-real', messages:[{role:'user',text:'test'}], retryDelayMs:1 };

test('key verification authenticates all providers without generation or URL secrets', async () => {
  for (const provider of ['gemini','anthropic','openai']) {
    let canceled = false;
    const result = await validateApiKey(provider, 'private-test-key', { fetchImpl: async (url, input) => {
      assert.match(url, /\/models(?:\?|$)/); assert.ok(!url.includes('private-test-key'));
      assert.equal(input.method, 'GET'); assert.equal(input.body, undefined); assert.equal(input.redirect, 'error');
      assert.equal(input.headers[provider === 'openai' ? 'Authorization' : provider === 'gemini' ? 'x-goog-api-key' : 'x-api-key'], provider === 'openai' ? 'Bearer private-test-key' : 'private-test-key');
      return { status: 200, body: { cancel: async () => { canceled = true; } } };
    } });
    assert.equal(result, true); assert.equal(canceled, true);
  }
});
test('rejected, unavailable and timed out key checks return safe errors', async () => {
  for (const status of [400,401,403,404,429,503]) {
    await assert.rejects(validateApiKey('gemini','private-test-key', { fetchImpl: async () => new Response('private-test-key', {status}) }), error => {
      assert.match(error.message, /saved key has not changed/); assert.ok(!error.message.includes('private-test-key')); return true;
    });
  }
  await assert.rejects(validateApiKey('anthropic','private-test-key', { fetchImpl: async () => { throw new TypeError('network error with private-test-key'); } }), /Could not connect to verify/);
  await assert.rejects(validateApiKey('gemini','private-test-key', { timeoutMs: 15, fetchImpl: async (_url,{signal}) => new Promise((_resolve,reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true})) }), /verification timed out/);
});

test('provider adapters keep keys in headers and send images in native formats', () => {
  const messages = [{role:'user', text:'solve', image:{mime:'image/jpeg',data:'pixels'}}, {role:'assistant',text:'answer'}];
  const claude = buildRequest('anthropic','claude-test','secret',messages);
  assert.equal(claude.body.messages[0].content[0].source.media_type,'image/jpeg'); assert.equal(claude.headers['x-api-key'],'secret'); assert.ok(!claude.url.includes('secret'));
  const gemini = buildRequest('gemini','gemini-test','secret',messages);
  assert.equal(gemini.body.contents[1].role,'model'); assert.equal(gemini.body.contents[0].parts[0].inlineData.data,'pixels'); assert.ok(!gemini.url.includes('secret'));
  const openai = buildRequest('openai','gpt-6.1-sol','secret',messages);
  assert.equal(openai.url,'https://api.openai.com/v1/responses');
  assert.equal(openai.headers.Authorization,'Bearer secret');
  assert.equal(openai.body.store,false);
  assert.equal(openai.body.input[0].content[0].image_url,'data:image/jpeg;base64,pixels');
  assert.equal(openai.body.input[0].content[1].type,'input_text');
  assert.equal(openai.body.input[1].content[0].type,'output_text');
});
test('all provider adapters send all ten images in order exactly once', () => {
  const images = Array.from({ length: 10 }, (_value, i) => ({ mime: 'image/jpeg', data: `pixels-${i}` }));
  const messages = [{ role: 'user', text: 'Compare all images', images, image: images[0] }, { role: 'assistant', text: 'Answer', images }];
  const claude = buildRequest('anthropic', 'test', 'secret', messages).body.messages;
  assert.deepEqual(claude[0].content.filter(part => part.type === 'image').map(part => part.source.data), images.map(image => image.data));
  assert.equal(claude[1].content.length, 1);
  const gemini = buildRequest('gemini', 'test', 'secret', messages).body.contents;
  assert.deepEqual(gemini[0].parts.filter(part => part.inlineData).map(part => part.inlineData.data), images.map(image => image.data));
  assert.equal(gemini[1].parts.length, 1);
  const openai = buildRequest('openai', 'test', 'secret', messages).body.input;
  assert.deepEqual(openai[0].content.filter(part => part.type === 'input_image').map(part => part.image_url), images.map(image => `data:image/jpeg;base64,${image.data}`));
  assert.equal(openai[1].content.length, 1);
});
test('OpenAI Responses streams text, ignores reasoning, and requires terminal events', async () => {
  const run = text => streamAnswer({...options,provider:'openai',model:'gpt-6.1-sol',fetchImpl:async()=>response(text,1)});
  const delta = frame({type:'response.output_text.delta',delta:'Hello 🌿'});
  const complete = frame({type:'response.completed',response:{status:'completed'}});
  assert.deepEqual(await run(frame({type:'response.reasoning_summary_text.delta',delta:'private'})+delta+complete),{text:'Hello 🌿',truncated:false});
  await assert.rejects(run(delta),/before the answer completed/);
  assert.deepEqual(await run(delta+frame({type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}})),{text:'Hello 🌿',truncated:true});
  for (const failure of [{type:'response.failed'},{type:'error',message:'secret'},{type:'response.refusal.delta',delta:'secret'},{type:'response.incomplete',response:{incomplete_details:{reason:'content_filter'}}}]) {
    await assert.rejects(run(frame(failure)),error=>!error.message.includes('secret'));
  }
});
test('OpenAI requests reject redirects and never retry a partial answer', async () => {
  let attempts = 0;
  await assert.rejects(streamAnswer({...options,provider:'openai',model:'gpt-6.1-sol',fetchImpl:async (_url,input) => {
    attempts++;
    assert.equal(input.redirect,'error');
    return response(frame({type:'response.output_text.delta',delta:'partial'})+frame({type:'response.failed',response:{error:{message:'sensitive provider details'}}}));
  }}), error => /OpenAI interrupted/.test(error.message) && !error.message.includes('sensitive'));
  assert.equal(attempts,1);
});
test('SSE handles fragmented CRLF, unicode and comments', async () => {
  const text = ': ping\r\n\r\n' + frame({text:'हेलो 🌿'});
  const result = []; for await (const event of parseSSE(response(text,1).body)) result.push(event);
  assert.deepEqual(result,[{text:'हेलो 🌿'}]);
});
test('Claude streams only answer text and requires a completion event', async () => {
  const deltas = [];
  const result = await streamAnswer({...options, fetchImpl:async()=>response(frame({type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}})+anthropicStream('Hello')), onDelta:delta=>deltas.push(delta)});
  assert.equal(result.text,'Hello'); assert.deepEqual(deltas,['Hello']);
  await assert.rejects(streamAnswer({...options,fetchImpl:async()=>response(frame({type:'content_block_delta',delta:{type:'text_delta',text:'Partial'}}))}), /before the answer completed/);
});
test('Gemini filters reasoning, detects blocked output and marks truncation', async () => {
  const result = await streamAnswer({...options,provider:'gemini',fetchImpl:async()=>response(frame({candidates:[{content:{parts:[{text:'internal',thought:true},{text:'42'}]},finishReason:'MAX_TOKENS'}]}))});
  assert.deepEqual(result,{text:'42',truncated:true});
  await assert.rejects(streamAnswer({...options,provider:'gemini',fetchImpl:async()=>response(frame({promptFeedback:{blockReason:'SAFETY'}}))}),/declined/);
});
test('retries transient failures only before output; authentication never retries', async () => {
  let attempts = 0;
  const result = await streamAnswer({...options,fetchImpl:async()=>++attempts===1?new Response('',{status:503}):response(anthropicStream('Recovered'))});
  assert.equal(attempts,2); assert.equal(result.text,'Recovered');
  attempts=0; await assert.rejects(streamAnswer({...options,fetchImpl:async()=>{attempts++;return new Response('',{status:401});}}),/key was rejected/); assert.equal(attempts,1);
  attempts=0; await assert.rejects(streamAnswer({...options,fetchImpl:async()=>{attempts++;return response(frame({type:'content_block_delta',delta:{type:'text_delta',text:'partial'}})+frame({type:'error',error:{type:'overloaded_error'}}));}}),/interrupted/); assert.equal(attempts,1);
});
test('retry budget is bounded and cancellation stops a pending network request', async () => {
  let attempts=0; await assert.rejects(streamAnswer({...options,fetchImpl:async()=>{attempts++;throw new TypeError('network');}}),/internet/); assert.equal(attempts,3);
  const controller = new AbortController();
  const promise = streamAnswer({...options,signal:controller.signal,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  controller.abort(); await assert.rejects(promise,/Answer stopped/);
});
test('total deadline includes stalled network requests', async () => {
  await assert.rejects(streamAnswer({...options,timeoutMs:15,fetchImpl:async(_url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))}), /timed out/);
});
test('malformed or unfinished SSE does not become a successful answer', async () => {
  await assert.rejects(streamAnswer({...options,fetchImpl:async()=>response('data: invalid\n\n')}), /invalid streaming/);
  await assert.rejects(streamAnswer({...options,fetchImpl:async()=>response('data: {"partial":')}), /during a streaming event/);
});

/** All identities, URLs and response bytes here are synthetic. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '../../..');
const moduleURL = (name: string) =>
  JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/catalog', name)).href);
let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-trusted-test-'));
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function run(code: string) {
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env.PATH, TEST_TEMP: temp },
    }
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}

const candidateFixture = `
import assert from 'node:assert/strict';
import { candidateStatus, validateCandidate } from ${moduleURL('candidate.mjs')};
const sha = 'a'.repeat(40);
const pr = {state:'open', base:{ref:'main',repo:{full_name:'altegio/altegio-pro-mcp'}},head:{sha}};
const env = {GITHUB_REPOSITORY:'altegio/altegio-pro-mcp',GITHUB_REF:'refs/heads/main',PR_NUMBER:'123',CANDIDATE_SHA:sha,GITHUB_TOKEN:'read-only-fixture',CATALOG_STATUS_TOKEN:'dedicated-status-fixture',GITHUB_RUN_ID:'456',VALIDATION:'success',JOB_STATUS:'success',GITHUB_OUTPUT:process.env.TEST_TEMP+'/output'};
const posted = [];
const request = async (url, options) => {
  if (url.includes('/pulls/')) {
    assert.equal(options.headers.Authorization,'Bearer read-only-fixture');
    return Response.json(pr);
  }
  assert.ok(url.endsWith('/statuses/'+sha));
  assert.equal(options.headers.Authorization,'Bearer dedicated-status-fixture');
  posted.push(JSON.parse(options.body));
  return Response.json({});
};
`;

describe('trusted SHA-bound reporting', () => {
  it('uses separate read/status identities and reports only the reviewed SHA', () => {
    run(`${candidateFixture}
      await candidateStatus({env,request});
      await candidateStatus({env,request,complete:true});
      assert.equal(posted[0].state,'success');
      assert.equal(posted[0].target_url,'https://github.com/altegio/altegio-pro-mcp/actions/runs/456');
    `);
    expect(fs.readFileSync(path.join(temp, 'output'), 'utf8')).toBe(
      `sha=${'a'.repeat(40)}\n`
    );
  });

  it.each([
    'stale',
    'closed',
    'base',
    'repository',
    'failed',
    'cancelled',
    'skipped',
    'api',
    'jobcancelled',
    'cleanupfailed',
  ])('fails closed when the final recheck or validation is %s', (reason) => {
    run(`${candidateFixture}
        const reason = ${JSON.stringify(reason)};
        if(reason==='stale') pr.head.sha='b'.repeat(40);
        if(reason==='closed') pr.state='closed';
        if(reason==='base') pr.base.ref='other';
        if(reason==='repository') pr.base.repo.full_name='other/repo';
        if(['failed','cancelled','skipped'].includes(reason)) env.VALIDATION=reason;
        if(reason==='jobcancelled') env.JOB_STATUS='cancelled';
        if(reason==='cleanupfailed') env.JOB_STATUS='failure';
        const fetcher=reason==='api' ? async (url,options)=> url.includes('/pulls/') ? Response.json({}, {status:403}) : request(url,options) : request;
        await assert.rejects(candidateStatus({env,request:fetcher,complete:true}));
        assert.equal(posted.length,1);
        assert.equal(posted[0].state,'failure');
      `);
  });

  it('rejects stale initial heads and dispatches outside trusted main', () => {
    run(`${candidateFixture}
      pr.head.sha='b'.repeat(40);
      await assert.rejects(candidateStatus({env,request}));
      env.GITHUB_REF='refs/pull/123/merge';
      await assert.rejects(candidateStatus({env,request,complete:true}));
      assert.equal(posted.length,0);
      assert.throws(()=>validateCandidate(pr,'invalid\\nsha=x'));
    `);
    expect(fs.existsSync(path.join(temp, 'output'))).toBe(false);
  });
});

const archiveFixture = `
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {acquireSnapshot} from ${moduleURL('fetch-spec.mjs')};
const bytes=Buffer.from('private-fixture-only');
const pin={archive_sha256:createHash('sha256').update(bytes).digest('hex')};
const env={SPEC_WIF_PROVIDER:'projects/123/locations/global/workloadIdentityPools/catalog-spec/providers/github',SPEC_ARCHIVE_URL:'https://storage.googleapis.com/download/storage/v1/b/fixture/o/spec.tar.gz?alt=media&generation=123',ACTIONS_ID_TOKEN_REQUEST_URL:'https://fixture.actions.githubusercontent.com/token',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'fixture-runner'};
const destination=process.env.TEST_TEMP+'/archive';
let count=0;
const request=async(url,options)=> {
  assert.equal(options.redirect,'error');
  count++;
  if(count===1){
    assert.equal(new URL(url).searchParams.get('audience'),'https://iam.googleapis.com/'+env.SPEC_WIF_PROVIDER);
    assert.equal(options.headers.Authorization,'Bearer fixture-runner');
    return Response.json({value:'fixture-oidc'});
  }
  if(count===2){
    const body=JSON.parse(options.body);
    assert.equal(body.subjectToken,'fixture-oidc');
    assert.equal(body.audience,'//iam.googleapis.com/'+env.SPEC_WIF_PROVIDER);
    assert.equal(body.scope,'https://www.googleapis.com/auth/devstorage.read_only');
    return Response.json({access_token:'fixture-object-only'});
  }
  assert.equal(options.headers.Authorization,'Bearer fixture-object-only');
  return new Response(bytes);
};
`;

describe('private immutable archive acquisition', () => {
  it('uses a short-lived object identity, verifies bytes and stores mode 0600', () => {
    run(`${archiveFixture}
      await acquireSnapshot({env,request,pin,destination});
      assert.equal(count,3);
      assert.deepEqual(await readFile(destination),bytes);
      assert.equal((await stat(destination)).mode & 0o777,0o600);
      assert.equal(existsSync(destination+'.part'),false);
    `);
  });

  it.each([
    'digest',
    'identity',
    'exchange',
    'download',
    'length',
    'stream',
    'redirect',
    'mutable',
    'host',
  ])('rejects %s failures and leaves no downloaded bytes', (reason) => {
    run(`${archiveFixture}
        const reason=${JSON.stringify(reason)};
        if(reason==='digest') pin.archive_sha256='0'.repeat(64);
        if(reason==='mutable') env.SPEC_ARCHIVE_URL=env.SPEC_ARCHIVE_URL.replace('&generation=123','');
        if(reason==='host') env.SPEC_ARCHIVE_URL=env.SPEC_ARCHIVE_URL.replace('storage.googleapis.com','untrusted.invalid');
        const fetcher=async(url,options)=>{
          if(reason==='identity' && count===0) return Response.json({}, {status:403});
          if(reason==='exchange' && count===1) return Response.json({}, {status:403});
          if(count===2){
            if(reason==='download') return new Response('',{status:403});
            if(reason==='length') return new Response(bytes,{headers:{'content-length':String(65*1024*1024)}});
            if(reason==='redirect') throw new Error('synthetic redirect refusal');
            if(reason==='stream') {
              let chunks=0;
              return new Response(new ReadableStream({pull(controller){ if(chunks++<65) controller.enqueue(new Uint8Array(1024*1024)); else controller.close(); }}));
            }
          }
          return request(url,options);
        };
        await assert.rejects(acquireSnapshot({env,request:fetcher,pin,destination}));
        assert.equal(existsSync(destination),false);
        assert.equal(existsSync(destination+'.part'),false);
        if(['mutable','host'].includes(reason)) assert.equal(count,0);
      `);
  });
});

describe('administrative rule activation', () => {
  it('preserves existing rules and rejects weakened checks or a different issuer', () => {
    run(`
      import assert from 'node:assert/strict';
      import {requiredRuleset} from ${moduleURL('admin.mjs')};
      const names=['Quality','Tests (Node 26)','Tests (Node 24)','Artifacts','Package (Node 24)','Dependency audit','CodeQL analysis'];
      const rules=[{type:'deletion'},{type:'non_fast_forward'},{type:'pull_request',parameters:{required_approving_review_count:0}},{type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,required_status_checks:names.map(context=>({context,integration_id:15368}))}}];
      const current={id:26491479,name:'main-reviewed-delivery',enforcement:'active',bypass_actors:[],conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules};
      const before=structuredClone(current);
      const proposed=requiredRuleset(current,999);
      assert.deepEqual(current,before);
      assert.deepEqual(proposed.rules.slice(0,3),rules.slice(0,3));
      assert.deepEqual(proposed.rules[3].parameters.required_status_checks.at(-1),{context:'Catalog (pinned spec)',integration_id:999});
      assert.throws(()=>requiredRuleset({...current,bypass_actors:[{actor_id:1}]},999));
      current.rules=proposed.rules;
      assert.throws(()=>requiredRuleset(current,998));
      current.rules[3].parameters.required_status_checks.shift();
      assert.throws(()=>requiredRuleset(current,999));
    `);
  });
});

describe('one-time owner App registration', () => {
  it('uses one-use state, stores the key privately and discards unused secrets', () => {
    run(`
      import assert from 'node:assert/strict';
      import {readFile,stat} from 'node:fs/promises';
      import {registration} from ${moduleURL('register-app.mjs')};
      const output=process.env.TEST_TEMP+'/registration';
      let conversions=0;
      const session=await registration({output,request:async(url,options)=>{
        conversions++;
        assert.ok(url.endsWith('/'+'a'.repeat(40)+'/conversions'));
        assert.equal(options.method,'POST');
        return Response.json({id:999,slug:'fixture-catalog-gate',pem:'-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----',client_secret:'discarded-fixture',webhook_secret:'discarded-fixture'});
      }});
      try {
        const page=await fetch(session.url);
        const html=await page.text();
        assert.ok(html.includes('statuses'));
        assert.ok(html.includes('&quot;active&quot;:false'));
        const url=new URL(session.url);
        const state=url.pathname.split('/').at(-1);
        const invalid=await fetch(url.origin+'/callback?code='+'a'.repeat(40)+'&state=wrong');
        assert.equal(invalid.status,403);
        assert.equal(conversions,0);
        const callback=url.origin+'/callback?code='+'a'.repeat(40)+'&state='+state;
        const converted=await fetch(callback);
        assert.equal(converted.status,200);
        assert.ok((await converted.text()).includes('https://github.com/apps/fixture-catalog-gate/installations/new'));
        assert.equal((await fetch(callback)).status,403);
        assert.equal(conversions,1);
        const metadata=await readFile(output+'/status-app.json','utf8');
        assert.deepEqual(JSON.parse(metadata),{id:999,slug:'fixture-catalog-gate'});
        assert.equal((await stat(output+'/status-app.pem')).mode & 0o777,0o600);
      } finally { await session.close(); }
      await assert.rejects(registration({output}));
    `);
  });
});

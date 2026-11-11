// Cases for views.yaml: `opengrep scan --test .opengrep`. `ruleid:` marks the next line as a
// finding the rule must report, `ok:` as one it must not. Never compiled or run: tsconfig.json and
// vitest.config.ts only take src/ and test/.

function Clock(props: { at: number }) {
  // ruleid: render-clock
  const now = Date.now();
  // ruleid: render-clock
  const today = new Date();
  // ruleid: render-clock
  const seed = Math.random();
  // ok: render-clock
  const at = new Date(props.at);
  // ok: render-clock
  const requestNow = useNow();
  useEffect(() => {
    // ok: render-clock
    setStarted(Date.now());
  }, []);
  const onClick = useCallback(() => {
    // ok: render-clock
    track(Math.random());
  }, []);
  return <div data-seed={seed} data-now={now} data-today={today} data-at={at} data-request={requestNow} onClick={onClick} />;
}

function Html(props: { json: string; html: string }) {
  // ok: raw-html
  const payload = <script id="hm-page" type="application/json" dangerouslySetInnerHTML={{ __html: props.json }} />;
  // ok: raw-html
  const ld = <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: props.json }} />;
  // ruleid: raw-html
  const markup = <div className="prose" dangerouslySetInnerHTML={{ __html: props.html }} />;
  // ruleid: raw-html
  const inline = <script dangerouslySetInnerHTML={{ __html: 'boot()' }} />;
  // ok: raw-html
  const text = <p>{props.html}</p>;
  // ruleid: raw-html
  document.body.innerHTML = props.html;
  return [payload, ld, markup, inline, text];
}

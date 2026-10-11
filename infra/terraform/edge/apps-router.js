// CloudFront Function (viewer-request) for the doax-app provider.
// Subdomain-per-namespace: https://<ns>.app.doax.io/ serves the bucket prefix /<ns>/,
// giving every app its own browser origin (apps can never read each other's storage).
// app.doax.io itself serves the provider landing page from the bucket root.
function handler(event) {
    var req = event.request;
    var host = req.headers.host.value;
    var uri = req.uri;
    var suffix = '.app.doax.io';
    var prefix = '';
    if (host !== 'app.doax.io' && host.indexOf(suffix) === host.length - suffix.length) {
        prefix = '/' + host.slice(0, -suffix.length);
    }
    if (uri === '/') { uri = '/index.html'; }
    else if (uri.slice(-1) === '/') { uri += 'index.html'; }
    else if (uri.split('/').pop().indexOf('.') === -1) { uri += '/index.html'; }
    req.uri = prefix + uri;
    return req;
}

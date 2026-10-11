// CloudFront Function (viewer-request) for the doax-app provider.
// 1) Authentication layer: every *.app.doax.io request needs a valid doax session cookie
//    (HMAC verified here at the edge); otherwise 302 to the registry's login page.
//    The provider landing at app.doax.io stays public.
// 2) Routing: <ns>.app.doax.io/ -> bucket prefix /<ns>/, with index.html handling.
var crypto = require('crypto');
var SECRET = '${session_secret}';
var LOGIN = '${login_url}';

function validSession(req) {
    var cookie = req.cookies && req.cookies['doax_session'];
    if (!cookie || !cookie.value) { return false; }
    var parts = cookie.value.split('.');
    if (parts.length !== 3) { return false; }
    if (!(Number(parts[0]) > Date.now())) { return false; }
    var expected = crypto.createHmac('sha256', SECRET).update(parts[0] + '.' + parts[1]).digest('hex');
    return expected === parts[2];
}

function handler(event) {
    var req = event.request;
    var host = req.headers.host.value;
    var uri = req.uri;
    var suffix = '.app.doax.io';
    var prefix = '';
    if (host !== 'app.doax.io' && host.indexOf(suffix) === host.length - suffix.length) {
        if (!validSession(req)) {
            return {
                statusCode: 302,
                statusDescription: 'Found',
                headers: { location: { value: LOGIN + '?return=' + encodeURIComponent('https://' + host + uri) } },
            };
        }
        prefix = '/' + host.slice(0, -suffix.length);
    }
    if (uri === '/') { uri = '/index.html'; }
    else if (uri.slice(-1) === '/') { uri += 'index.html'; }
    else if (uri.split('/').pop().indexOf('.') === -1) { uri += '/index.html'; }
    req.uri = prefix + uri;
    return req;
}

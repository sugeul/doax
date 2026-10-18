// doax.io clean-URL router (CloudFront Function, viewer-request).
// Scope: /playbook only. An extensionless request resolves to the .html object at the edge, so a
// permalink like /playbook/localapps/overnight-digest-in-the-terminal serves ...-terminal.html —
// a routing concern, not duplicated files. Other paths (/, /install, /install.sh, assets) are
// left untouched so existing extensionless objects keep working.
function handler(event) {
    var req = event.request;
    var uri = req.uri;
    if (uri === "/playbook" || uri.indexOf("/playbook/") === 0) {
        if (uri.length > 1 && uri.charAt(uri.length - 1) === "/") uri = uri.slice(0, -1);
        var last = uri.substring(uri.lastIndexOf("/") + 1);
        if (last.indexOf(".") === -1) uri = uri + ".html"; // extensionless -> .html
        req.uri = uri;
    }
    return req;
}

// CloudFront Function (viewer-request): answers CORS preflight at the edge so the
// registry Lambda never sees OPTIONS. Mirrors kachit's edge/cf-gw/options role.
function handler(event) {
    var req = event.request;
    if (req.method === 'OPTIONS') {
        return {
            statusCode: 204,
            statusDescription: 'No Content',
            headers: {
                'access-control-allow-origin': { value: '*' },
                'access-control-allow-methods': { value: 'GET,HEAD,POST,PUT,DELETE,OPTIONS' },
                'access-control-allow-headers': { value: 'content-type,authorization' },
                'access-control-max-age': { value: '86400' }
            }
        };
    }
    return req;
}

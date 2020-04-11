var express = require("express");
var url = require("url");
var bodyParser = require('body-parser');
var randomstring = require("randomstring");
var cons = require('consolidate');
var nosql = require('nosql').load('database.nosql');
var querystring = require('querystring');
var __ = require('underscore');
__.string = require('underscore.string');
var jwk = require('node-jose');

var app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended: true})); // support form-encoded bodies (for the token endpoint)

app.engine('html', cons.underscore);
app.set('view engine', 'html');
app.set('views', 'files/authorizationServer');
app.set('json spaces', 4);

// authorization server information
var authServer = {
    authorizationEndpoint: 'http://localhost:9001/authorize',
    tokenEndpoint: 'http://localhost:9001/token'
};

// client information
var clients = [
    {
        "client_id": "oauth-client-1",
        "client_secret": "oauth-client-secret-1",
        "redirect_uris": ["http://localhost:9000/callback"],
        "scope": "foo bar"
    }
];

var protectedResources = [
    {
        "resource_id": "protected-resource-1",
        "resource_secret": "protected-resource-secret-1"
    }
];

var codes = {};

var requests = {};

var keystore = jwk.JWK.createKeyStore();

var getClient = function (clientId) {
    return __.find(clients, function (client) {
        return client.client_id == clientId;
    });
};

var getProtectedResource = function (resourceId) {
    return __.find(protectedResources, function (resource) {
        return resource.resource_id == resourceId;
    });
};

app.get('/', function (req, res) {
    res.render('index', {clients: clients, authServer: authServer});
});

app.get("/authorize", function (req, res) {

    var client = getClient(req.query.client_id);

    if (!client) {
        console.log('Unknown client %s', req.query.client_id);
        res.render('error', {error: 'Unknown client'});
        return;
    } else if (!__.contains(client.redirect_uris, req.query.redirect_uri)) {
        console.log('Mismatched redirect URI, expected %s got %s', client.redirect_uris, req.query.redirect_uri);
        res.render('error', {error: 'Invalid redirect URI'});
        return;
    } else {

        var rscope = req.query.scope ? req.query.scope.split(' ') : undefined;
        var cscope = client.scope ? client.scope.split(' ') : undefined;
        if (__.difference(rscope, cscope).length > 0) {
            // client asked for a scope it couldn't have
            var urlParsed = buildUrl(req.query.redirect_uri, {
                error: 'invalid_scope'
            });
            res.redirect(urlParsed);
            return;
        }

        var reqid = randomstring.generate(8);

        requests[reqid] = req.query;

        res.render('approve', {client: client, reqid: reqid, scope: rscope});
        return;
    }

});

app.post('/approve', function (req, res) {

    var reqid = req.body.reqid;
    var query = requests[reqid];
    delete requests[reqid];

    if (!query) {
        // there was no matching saved request, this is an error
        res.render('error', {error: 'No matching authorization request'});
        return;
    }

    if (req.body.approve) {
        if (query.response_type == 'code') {
            // user approved access
            var code = randomstring.generate(8);

            var scope = getScopesFromForm(req.body);

            var client = getClient(query.client_id);
            var cscope = client.scope ? client.scope.split(' ') : undefined;
            if (__.difference(scope, cscope).length > 0) {
                // client asked for a scope it couldn't have
                var urlParsed = buildUrl(query.redirect_uri, {
                    error: 'invalid_scope'
                });
                res.redirect(urlParsed);
                return;
            }

            // save the code and request for later
            codes[code] = {request: query, scope: scope};

            var urlParsed = buildUrl(query.redirect_uri, {
                code: code,
                state: query.state
            });
            res.redirect(urlParsed);
            return;
        } else {
            // we got a response type we don't understand
            var urlParsed = buildUrl(query.redirect_uri, {
                error: 'unsupported_response_type'
            });
            res.redirect(urlParsed);
            return;
        }
    } else {
        // user denied access
        var urlParsed = buildUrl(query.redirect_uri, {
            error: 'access_denied'
        });
        res.redirect(urlParsed);
        return;
    }

});

app.post("/token", function (req, res) {

    var auth = req.headers['authorization'];
    if (auth) {
        // check the auth header
        var clientCredentials = decodeClientCredentials(auth);
        var clientId = clientCredentials.id;
        var clientSecret = clientCredentials.secret;
    }

    // otherwise, check the post body
    if (req.body.client_id) {
        if (clientId) {
            // if we've already seen the client's credentials in the authorization header, this is an error
            console.log('Client attempted to authenticate with multiple methods');
            res.status(401).json({error: 'invalid_client'});
            return;
        }

        var clientId = req.body.client_id;
        var clientSecret = req.body.client_secret;
    }

    var client = getClient(clientId);
    if (!client) {
        console.log('Unknown client %s', clientId);
        res.status(401).json({error: 'invalid_client'});
        return;
    }

    if (client.client_secret != clientSecret) {
        console.log('Mismatched client secret, expected %s got %s', client.client_secret, clientSecret);
        res.status(401).json({error: 'invalid_client'});
        return;
    }

    if (req.body.grant_type == 'authorization_code') {

        var code = codes[req.body.code];

        if (code) {
            delete codes[req.body.code]; // burn our code, it's been used
            if (code.request.client_id == clientId) {

                keystore.generate('RSA', 2048).then(function (key) {
                    var access_token = randomstring.generate();

                    var access_token_key = key.toJSON(true); // get keypair in JWK format
                    var access_token_public_key = key.toJSON(); // get public key in JWK format

                    var token_response = {
                        access_token: access_token,
                        access_token_key: access_token_key,
                        token_type: 'PoP',
                        refresh_token: req.body.refresh_token,
                        scope: code.scope,
                        alg: 'RS256'
                    };

                    nosql.insert({
                        access_token: access_token,
                        access_token_key: access_token_public_key,
                        client_id: clientId,
                        scope: code.scope
                    });

                    res.status(200).json(token_response);
                    console.log('Issued tokens for code %s', req.body.code);

                    return;
                });

            } else {
                console.log('Client mismatch, expected %s got %s', code.request.client_id, clientId);
                res.status(400).json({error: 'invalid_grant'});
                return;
            }
        } else {
            console.log('Unknown code, %s', req.body.code);
            res.status(400).json({error: 'invalid_grant'});
            return;
        }
    } else {
        console.log('Unknown grant type %s', req.body.grant_type);
        res.status(400).json({error: 'unsupported_grant_type'});
    }
});

app.post('/introspect', function (req, res) {
    var auth = req.headers['authorization'];
    var resourceCredentials = decodeClientCredentials(auth);
    var resourceId = resourceCredentials.id;
    var resourceSecret = resourceCredentials.secret;

    var resource = getProtectedResource(resourceId);
    if (!resource) {
        console.log('Unknown resource %s', resourceId);
        res.status(401).end();
        return;
    }

    if (resource.resource_secret != resourceSecret) {
        console.log('Mismatched secret, expected %s got %s', resource.resource_secret, resourceSecret);
        res.status(401).end();
        return;
    }

    var inToken = req.body.token;
    console.log('Introspecting token %s', inToken);
    nosql.one(function (token) {
        if (token.access_token == inToken) {
            return token;
        }
    }, function (err, token) {
        if (token) {
            console.log("We found a matching token: %s", inToken);

            var introspectionResponse = {
                active: true,
                iss: 'http://localhost:9001/',
                aud: 'http://localhost:9002/',
                sub: token.user ? token.user.sub : undefined,
                username: token.user ? token.user.preferred_username : undefined,
                scope: token.scope ? token.scope.join(' ') : undefined,
                client_id: token.client_id
            };

            introspectionResponse.access_token_key = token.access_token_key;

            res.status(200).json(introspectionResponse);
            return;
        } else {
            console.log('No matching token was found.');

            var introspectionResponse = {
                active: false
            };
            res.status(200).json(introspectionResponse);
            return;
        }
    });


});


app.use('/', express.static('files/authorizationServer'));

var buildUrl = function (base, options, hash) {
    var newUrl = url.parse(base, true);
    delete newUrl.search;
    if (!newUrl.query) {
        newUrl.query = {};
    }
    __.each(options, function (value, key, list) {
        newUrl.query[key] = value;
    });
    if (hash) {
        newUrl.hash = hash;
    }

    return url.format(newUrl);
};

var getScopesFromForm = function (body) {
    return __.filter(__.keys(body), function (s) {
        return __.string.startsWith(s, 'scope_');
    })
        .map(function (s) {
            return s.slice('scope_'.length);
        });
};

var decodeClientCredentials = function (auth) {
    var clientCredentials = new Buffer(auth.slice('basic '.length), 'base64').toString().split(':');
    var clientId = querystring.unescape(clientCredentials[0]);
    var clientSecret = querystring.unescape(clientCredentials[1]);
    return {id: clientId, secret: clientSecret};
};

// clear the database
nosql.clear();

var server = app.listen(9001, 'localhost', function () {
    var host = server.address().address;
    var port = server.address().port;

    console.log('OAuth Authorization Server is listening at http://%s:%s', host, port);
});
 

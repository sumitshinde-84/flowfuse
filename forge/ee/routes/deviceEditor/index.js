const { generateToken } = require('../../../db/utils')
const { registerPermissions } = require('../../../lib/permissions')
const { Roles } = require('../../../lib/roles.js')

/**
 * Routes releated to the EE forge api
 * @param {import('../../forge').ForgeApplication} app - forge application
 * @namespace api
 * @memberof forge.ee
 */
module.exports = async function (app) {
    registerPermissions({
        'device:editor': { description: 'Access the Device Editor', role: Roles.Member }
    })

    app.addHook('preHandler', app.verifySession)
    app.addHook('preHandler', async (request, reply) => {
        if (request.params.deviceId !== undefined) {
            if (request.params.deviceId) {
                try {
                    request.device = await app.db.models.Device.byId(request.params.deviceId)
                    if (!request.device) {
                        reply.code(404).send({ code: 'not_found', error: 'Not Found' })
                        return
                    }
                    if (request.session.User) {
                        request.teamMembership = await request.session.User.getTeamMembership(request.device.Team.id)
                    }
                } catch (err) {
                    reply.code(404).send({ code: 'not_found', error: 'Not Found' })
                }
            } else {
                reply.code(404).send({ code: 'not_found', error: 'Not Found' })
            }
        }
    })
    /**
     * Enable/Disable device editor
     * @name /api/v1/devices/:deviceId/editor
     * @memberof module:forge/routes/api/device
     */
    app.put('/', {
        preHandler: app.needsPermission('device:editor')
    }, async (request, reply) => {
        const mode = request.body.tunnel || 'disable'
        const team = await app.db.models.Team.byId(request.device.TeamId)
        /** @type {DeviceTunnelManager} */
        const tunnelManager = app.comms.devices.tunnelManager
        const deviceId = request.device.hashid
        const teamId = team.hashid
        if (mode === 'enable') {
            // Generate a random access token for editor, open a tunnel and start the editor
            const accessToken = await generateToken(16, `ffde_${deviceId}`)
            // prepare the tunnel but dont start it (the remote device will initiate the connection)
            // * Enable Device Editor (Step 3) - (frontendApi:HTTP->forge) Create Tunnel
            tunnelManager.newTunnel(deviceId, accessToken)
            let err = null
            try {
                // * Enable Device Editor (Step 4) - (forge) Enable Editor Request. This call resolves after steps 5 ~ 10
                await app.comms.devices.enableEditor(teamId, request.device.hashid, accessToken)
            } catch (error) {
                // ensure any attempt to enable the editor is cleaned up if an error occurs
                tunnelManager.closeTunnel(deviceId)
                err = error
            }
            // * Enable Device Editor (Step 11) - (forge:HTTP->frontendApi) Send tunnel status back to frontend
            const tunnelStatus = tunnelManager.getTunnelStatus(request.device.hashid) || {}
            if (err) {
                tunnelStatus.error = err.message
                tunnelStatus.code = err.code || 'enable_editor_failed'
                await app.auditLog.Team.team.device.remoteAccess.enabled(request.session.User, tunnelStatus, team, request.device)
                reply.code(503).send(tunnelStatus) // Service Unavailable
            } else {
                await app.auditLog.Team.team.device.remoteAccess.enabled(request.session.User, null, team, request.device)
                reply.send(tunnelStatus)
            }
        } else if (mode === 'disable') {
            await app.comms.devices.disableEditor(teamId, deviceId)
            tunnelManager.closeTunnel(deviceId)
            await app.auditLog.Team.team.device.remoteAccess.disabled(request.session.User, null, team, request.device)
            reply.send({ enabled: false })
        } else {
            reply.code(400).send({ code: 'invalid_request', error: 'Expected device editor tunnel mode option to be either "enabled" or "disabled"' })
        }
    })

    /**
     * Get device editor state and url
     * @name /api/v1/devices/:deviceId/editor
     * @memberof module:forge/routes/api/device
     */
    app.get('/', {
        preHandler: app.needsPermission('device:editor')
    }, async (request, reply) => {
        /** @type {DeviceTunnelManager} */
        const tunnelManager = app.comms.devices.tunnelManager
        reply.send(tunnelManager.getTunnelStatus(request.device.hashid))
    })

    /**
     * HTTP GET: verify adminAuth token
     * As this will be called by NR auth, this endpoint cannot be protected by the
     * normal forge auth middleware
     * @name /api/v1/devices/:deviceId/editor/token
     */
    app.get('/token', {
        config: { allowAnonymous: true }
    }, async (request, reply) => {
        const tunnelManager = getTunnelManager()
        if (tunnelManager.verifyToken(request.params.deviceId, request.headers['x-access-token'])) {
            reply.code(200).send({ username: 'forge', permissions: '*' })
            return
        }
        reply.code(401).send({ code: 'unauthorized', error: 'unauthorized' })
    })

    /**
     * Initiate inbound websocket connection from device
     * @name /api/v1/devices/:deviceId/editor/comms/:access_token
     */
    app.get('/comms/:access_token', {
        config: { allowAnonymous: true },
        websocket: true
    }, (connection, request) => {
        // * Enable Device Editor (Step 9) - (device:WS->forge) websocket connect request from device
        // This is the inbound websocket connection from the device
        const deviceId = request.params.deviceId
        const token = request.params.access_token
        const tunnelManager = getTunnelManager()
        const tunnelInfo = tunnelManager.getTunnelStatus(deviceId)
        if (tunnelInfo) {
            if (tunnelManager.verifyToken(deviceId, token)) {
                const tunnelSetupOK = tunnelManager.initTunnel(deviceId, token, connection)
                if (!tunnelSetupOK) {
                    connection.socket.close(1008, 'Tunnel setup failed')
                }
            } else {
                connection.socket.close(1008, 'Invalid token')
            }
        } else {
            connection.socket.close(1008, 'No tunnel')
        }
    })

    /**
     * HTTP GET and WS requests from device
     * @name /api/v1/devices/:deviceId/editor/proxy/*
     */
    app.route({
        method: 'GET', // only GET is permitted for WS
        url: '/proxy/*',
        handler: (request, reply) => {
            // Handle HTTP GET requests from the device
            const tunnelManager = getTunnelManager()
            if (tunnelManager.handleHTTP(request.params.deviceId, request, reply)) {
                return
            } else if (tunnelManager.getTunnelStatus(request.params.deviceId)) {
                reply.code(502).send() // Bad Gateway (tunnel exists but it has lost connection or is in an intermediate state)
                return
            }
            // tunnel does not exist
            reply.code(503).send() // Service Unavailable
        },
        wsHandler: (connection, request) => {
            // Handle WS connection from the device
            const tunnelManager = getTunnelManager()
            if (tunnelManager.handleWS(request.params.deviceId, connection, request)) {
                return // handled
            }
            // not handled
            connection.socket.close(1008, 'No tunnel established')
        }
    })

    /**
     * HTTP POST, DELETE, PUT requests from device
     * @name/api/v1/devices/:deviceId/editor/proxy/*
     */
    app.route({
        method: ['POST', 'DELETE', 'PUT', 'HEAD', 'OPTIONS'],
        url: '/proxy/*',
        handler: (request, reply) => {
            const tunnelManager = getTunnelManager()
            if (tunnelManager.handleHTTP(request.params.deviceId, request, reply)) {
                return // handled
            } else if (tunnelManager.getTunnelStatus(request.params.deviceId)) {
                reply.code(502).send() // Bad Gateway (tunnel exists but it has lost connection or is in an intermediate state)
                return
            }
            // tunnel does not exist
            reply.code(503).send() // Service Unavailable
        }
    })

    // #region Helpers
    /**
     * Get the device tunnel manager for the app
     * @returns {import('../../lib/deviceEditor/DeviceTunnelManager').DeviceTunnelManager}
     */
    function getTunnelManager () {
        return app.comms.devices.tunnelManager
    }
    // #endregion
}
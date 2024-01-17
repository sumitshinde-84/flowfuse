const { Op } = require('sequelize')

const { randomInt } = require('../utils')

module.exports = {
    name: 'expireTokens',
    startup: true,
    // Pick a random hour/minute for this task to run at. If the application is
    // horizontal scaled, this will avoid two instances running at the same time
    schedule: `${randomInt(0, 59)} ${randomInt(0, 23)} * * *`,
    run: async function (app) {
        await app.db.models.Session.destroy({ where: { expiresAt: { [Op.lt]: Date.now() } } })
        await app.db.models.AccessToken.destroy({ where: { expiresAt: { [Op.lt]: Date.now() } } })
    }
}

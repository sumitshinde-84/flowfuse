describe('FlowForge', () => {
    it('successfully loads', () => {
        cy.visit('/')
    })
    it('prevents a user logging in with incorrect credentials', () => {
        cy.visit('/')
        // fill out credentials
        cy.get('div[label=username] input').type('wrongusername')
        cy.get('div[label=password] input').type('wrongpassword')
        // Ensure no error message displayed
        cy.get('.ff-error-inline').should('not.be.visible')
        // click "login"
        cy.get('.ff-actions button').click()
        // display "Login Failed"
        cy.get('.ff-error-inline').should('be.visible')
        // check where we are
        cy.url().should('not.include', '/overview')
    })
    it('requires a password', () => {
        cy.visit('/')
        // fill out credentials
        cy.get('div[label=username] input').type('wrongusername')
        // click "login"
        cy.get('.ff-actions button').click()
        // display "Required Field"
        cy.get('div[label=password]').should('have.class', 'ff-input--error')
        cy.get('.ff-error-inline').should('be.visible')
        // check where we are
        cy.url().should('not.include', '/overview')
    })
    it('allows a user to login', () => {
        cy.visit('/')
        // fill out credentials
        cy.get('div[label=username] input').type('alice')
        cy.get('div[label=password] input').type('aaPassword')
        // click "login"
        cy.get('.ff-actions button').click()
        // check where we are
        cy.url().should('include', '/overview')
    })
})
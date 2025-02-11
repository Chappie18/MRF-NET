import cluster from 'cluster'

import Browser from './browser/Browser'
import BrowserFunc from './browser/BrowserFunc'
import BrowserUtil from './browser/BrowserUtil'

import { log } from './util/Logger'
import Util from './util/Utils'
import { loadAccounts, loadConfig } from './util/Load'

import { Login } from './functions/Login'
import { Workers } from './functions/Workers'
import Activities from './functions/Activities'

import { Account } from './interface/Account'

// Main bot class
export class MicrosoftRewardsBot {
    public log: typeof log
    public config
    public utils: Util
    public activities: Activities = new Activities(this)
    public browser: {
        func: BrowserFunc,
        utils: BrowserUtil
    }

    private collectedPoints: number = 0
    private activeWorkers: number
    private browserFactory: Browser = new Browser(this)
    private accounts: Account[]
    private workers: Workers
    private login = new Login(this)

    constructor() {
        this.log = log

        this.accounts = []
        this.utils = new Util()
        this.workers = new Workers(this)
        this.browser = {
            func: new BrowserFunc(this),
            utils: new BrowserUtil(this)
        }
        this.config = loadConfig()
        this.activeWorkers = this.config.clusters
    }

    async initialize() {
        this.accounts = loadAccounts()
    }

    async run() {
        log('MAIN', `Bot started with ${this.config.clusters} clusters`)

        // Only cluster when there's more than 1 cluster demanded
        if (this.config.clusters > 1) {
            if (cluster.isPrimary) {
                this.runMaster()
            } else {
                this.runWorker()
            }
        } else {
            this.runTasks(this.accounts)
        }
    }

    private runMaster() {
        log('MAIN-PRIMARY', 'Primary process started')

        const accountChunks = this.utils.chunkArray(this.accounts, this.config.clusters)

        for (let i = 0; i < accountChunks.length; i++) {
            const worker = cluster.fork()
            const chunk = accountChunks[i]
            worker.send({ chunk })
        }

        cluster.on('exit', (worker, code) => {
            this.activeWorkers -= 1

            log('MAIN-WORKER', `Worker ${worker.process.pid} destroyed | Code: ${code} | Active workers: ${this.activeWorkers}`, 'warn')

            // Check if all workers have exited
            if (this.activeWorkers === 0) {
                log('MAIN-WORKER', 'All workers destroyed. Exiting main process!', 'warn')
                process.exit(0)
            }
        })
    }

    private runWorker() {
        log('MAIN-WORKER', `Worker ${process.pid} spawned`)
        // Receive the chunk of accounts from the master
        process.on('message', async ({ chunk }) => {
            await this.runTasks(chunk)
        })
    }

    private async runTasks(accounts: Account[]) {
        for (const account of accounts) {
            log('MAIN-WORKER', `Started tasks for account ${account.email}`)

            // Desktop Searches, DailySet and More Promotions
            await this.Desktop(account)

            // If runOnZeroPoints is false and 0 points to earn, stop and try the next account
            if (!this.config.runOnZeroPoints && this.collectedPoints === 0) {
                continue
            }

            // Mobile Searches
            await this.Mobile(account)

            log('MAIN-WORKER', `Completed tasks for account ${account.email}`)
        }

        log('MAIN-PRIMARY', 'Completed tasks for ALL accounts')
        log('MAIN-PRIMARY', 'All workers destroyed!')
        process.exit(0)
    }

    // Desktop
    async Desktop(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.email, account.proxy, false)
        const page = await browser.newPage()
        let pages = await browser.pages()

        // If for some reason the browser initializes with more than 2 pages, close these
        while (pages.length > 2) {
            await pages[0]?.close()
            pages = await browser.pages()
        }

        // Log into proxy
        await page.authenticate({ username: account.proxy.username, password: account.proxy.password })

        log('MAIN', 'Starting DESKTOP browser')

        // Login into MS Rewards
        await this.login.login(page, account.email, account.password)

        const wentHome = await this.browser.func.goHome(page)
        if (!wentHome) {
            throw log('MAIN', 'Unable to get dashboard page', 'error')
        }

        const data = await this.browser.func.getDashboardData(page)
        log('MAIN-POINTS', `Current point count: ${data.userStatus.availablePoints}`)

        const earnablePoints = await this.browser.func.getEarnablePoints(data)
        this.collectedPoints = earnablePoints
        log('MAIN-POINTS', `You can earn ${earnablePoints} points today`)

        // If runOnZeroPoints is false and 0 points to earn, don't continue
        if (!this.config.runOnZeroPoints && this.collectedPoints === 0) {
            log('MAIN', 'No points to earn and "runOnZeroPoints" is set to "false", stopping')

            // Close desktop browser
            return await browser.close()
        }

        // Complete daily set
        if (this.config.workers.doDailySet) {
            await this.workers.doDailySet(page, data)
        }

        // Complete more promotions
        if (this.config.workers.doMorePromotions) {
            await this.workers.doMorePromotions(page, data)
        }

        // Complete punch cards
        if (this.config.workers.doPunchCards) {
            await this.workers.doPunchCard(page, data)
        }

        // Do desktop searches
        if (this.config.workers.doDesktopSearch) {
            await this.activities.doSearch(page, data, false)
        }

        // Close desktop browser
        await browser.close()
    }

    // Mobile
    async Mobile(account: Account) {
        const browser = await this.browserFactory.createBrowser(account.email, account.proxy, true)
        const page = await browser.newPage()
        let pages = await browser.pages()

        // If for some reason the browser initializes with more than 2 pages, close these
        while (pages.length > 2) {
            await pages[0]?.close()
            pages = await browser.pages()
        }
        // Log into proxy
        await page.authenticate({ username: account.proxy.username, password: account.proxy.password })

        log('MAIN', 'Starting MOBILE browser')

        // Login into MS Rewards
        await this.login.login(page, account.email, account.password)

        await this.browser.func.goHome(page)

        const data = await this.browser.func.getDashboardData(page)

        // If no mobile searches data found, stop (Does not exist on new accounts)
        if (!data.userStatus.counters.mobileSearch) {
            log('MAIN', 'No mobile searches found, stopping')

            // Close mobile browser
            return await browser.close()
        }

        // Do mobile searches
        if (this.config.workers.doMobileSearch) {
            await this.activities.doSearch(page, data, true)
        }

        // Fetch new points
        const earnablePoints = await this.browser.func.getEarnablePoints(data, page)

        // If the new earnable is 0, means we got all the points, else retract
        this.collectedPoints = earnablePoints === 0 ? this.collectedPoints : (this.collectedPoints - earnablePoints)
        log('MAIN-POINTS', `The script collected ${this.collectedPoints} points today`)

        // Close mobile browser
        await browser.close()
    }
}

const bot = new MicrosoftRewardsBot()

// Initialize accounts first and then start the bot
bot.initialize().then(() => {
    bot.run()
})
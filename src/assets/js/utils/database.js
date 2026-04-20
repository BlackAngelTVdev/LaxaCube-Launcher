/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { ipcRenderer } = require('electron')
const path = require('path')
const fs = require('fs')
const { NodeBDD, DataType } = require('node-bdd')

class database {
    constructor() {
        this.writeLocks = new Map()
        this.migrationPromise = null
    }

    async getDatabasesPath() {
        const userDataPath = await ipcRenderer.invoke('path-user-data')
        const databasesPath = path.join(userDataPath, 'databases')
        if (!fs.existsSync(databasesPath)) fs.mkdirSync(databasesPath, { recursive: true })
        return databasesPath
    }

    async getTableFilePath(tableName) {
        const databasesPath = await this.getDatabasesPath()
        return path.join(databasesPath, `${tableName}.json`)
    }

    async readTableRows(tableName) {
        const filePath = await this.getTableFilePath(tableName)
        if (!fs.existsSync(filePath)) return []

        try {
            const rawData = fs.readFileSync(filePath, 'utf8')
            if (!rawData.trim()) return []
            const parsed = JSON.parse(rawData)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }

    async writeTableRows(tableName, rows) {
        const filePath = await this.getTableFilePath(tableName)
        const tempFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`
        fs.writeFileSync(tempFilePath, JSON.stringify(rows, null, 2), 'utf8')
        fs.renameSync(tempFilePath, filePath)
    }

    enqueueWrite(tableName, task) {
        const lastTask = this.writeLocks.get(tableName) || Promise.resolve()
        const nextTask = lastTask.then(task, task)
        this.writeLocks.set(tableName, nextTask.catch(() => undefined))
        return nextTask
    }

    async migrateLegacyIfNeeded() {
        if (!this.migrationPromise) {
            this.migrationPromise = this._migrateLegacyIfNeeded()
        }
        return this.migrationPromise
    }

    async _migrateLegacyIfNeeded() {
        const accountsPath = await this.getTableFilePath('accounts')
        const configPath = await this.getTableFilePath('configClient')

        const hasAccounts = fs.existsSync(accountsPath)
        const hasConfig = fs.existsSync(configPath)
        if (hasAccounts && hasConfig) return

        const userDataPath = await ipcRenderer.invoke('path-user-data')
        const roamingPath = path.dirname(path.dirname(userDataPath))

        const legacyPaths = [
            path.join(roamingPath, 'LaxaCube Launcher', 'databases'),
            path.join(process.cwd(), 'data', 'Launcher', 'databases')
        ]

        for (const legacyPath of legacyPaths) {
            const legacyDbFile = path.join(legacyPath, 'Databases.db')
            if (!fs.existsSync(legacyDbFile)) continue

            const legacy = new NodeBDD()
            const fileTypes = ['db', 'sqlite']

            for (const fileType of fileTypes) {
                try {
                    for (const tableName of ['configClient', 'accounts']) {
                        const targetFilePath = await this.getTableFilePath(tableName)
                        if (fs.existsSync(targetFilePath)) continue

                        const table = await legacy.intilize({
                            databaseName: 'Databases',
                            fileType: fileType,
                            tableName: tableName,
                            path: legacyPath,
                            tableColumns: {
                                json_data: DataType.TEXT.TEXT,
                            },
                        })

                        let rows = await legacy.getAllData(table)
                        if (!Array.isArray(rows) || !rows.length) continue

                        const normalizedRows = rows
                            .filter(row => row && typeof row.id !== 'undefined' && typeof row.json_data === 'string')
                            .map(row => ({ id: row.id, json_data: row.json_data }))

                        if (normalizedRows.length) {
                            await this.writeTableRows(tableName, normalizedRows)
                        }
                    }

                    return
                } catch {
                    // Try next file type or path.
                }
            }
        }
    }

    async creatDatabase(tableName, tableConfig) {
        await this.getDatabasesPath()
        await this.migrateLegacyIfNeeded()
        return { tableName, tableConfig }
    }

    async getDatabase(tableName) {
        return await this.creatDatabase(tableName, {
            json_data: 'TEXT',
        });
    }

    async createData(tableName, data) {
        await this.getDatabase(tableName)
        return await this.enqueueWrite(tableName, async () => {
            const rows = await this.readTableRows(tableName)
            const nextId = rows.reduce((max, row) => Math.max(max, row.id || 0), 0) + 1
            const row = { id: nextId, json_data: JSON.stringify(data) }
            rows.push(row)
            await this.writeTableRows(tableName, rows)

            const parsedData = JSON.parse(row.json_data)
            parsedData.ID = row.id
            return parsedData
        })
    }

    async readData(tableName, key = 1) {
        await this.getDatabase(tableName)
        const rows = await this.readTableRows(tableName)
        if (!rows.length) return undefined

        let row = rows.find(item => item.id == key)
        if (!row) row = rows[0]
        if (!row) return undefined

        const parsedData = JSON.parse(row.json_data)
        parsedData.ID = row.id
        return parsedData
    }

    async readAllData(tableName) {
        await this.getDatabase(tableName)
        const rows = await this.readTableRows(tableName)
        if (!Array.isArray(rows)) return []

        return rows.map(info => {
            const parsedData = JSON.parse(info.json_data)
            parsedData.ID = info.id
            return parsedData
        })
    }

    async updateData(tableName, data, key = 1) {
        await this.getDatabase(tableName)
        await this.enqueueWrite(tableName, async () => {
            const rows = await this.readTableRows(tableName)

            if (!rows.length) {
                rows.push({ id: 1, json_data: JSON.stringify(data) })
                await this.writeTableRows(tableName, rows)
                return
            }

            const index = rows.findIndex(item => item.id == key)
            const targetIndex = index !== -1 ? index : 0
            const targetId = rows[targetIndex].id || key
            rows[targetIndex] = { id: targetId, json_data: JSON.stringify(data) }
            await this.writeTableRows(tableName, rows)
        })
    }

    async deleteData(tableName, key = 1) {
        await this.getDatabase(tableName)
        await this.enqueueWrite(tableName, async () => {
            const rows = await this.readTableRows(tableName)
            const filteredRows = rows.filter(item => item.id != key)
            await this.writeTableRows(tableName, filteredRows)
        })
    }
}

export default database;
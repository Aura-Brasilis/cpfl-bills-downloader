import dotenv from 'dotenv'
dotenv.config()

import axios from 'axios'
import crypto from 'crypto'
import puppeteer from 'puppeteer'
import https from 'https'
import fs from 'fs'
import fsPromise from 'fs/promises'
import { fileURLToPath } from "url"
import path from 'path'
import FormData from 'form-data'
import sgMail from '@sendgrid/mail'

const ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
const IV = Buffer.from(process.env.IV, 'hex')

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

let browser

setInterval(() => {}, 1000)

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM. Closing resources...')

  try {
    if (browser) {
      await browser.close()
      console.log('Puppeteer closed')
    }
  } catch (err) {
    console.error('Error on close browser:', err.message)
  } finally {
    process.exit(0)
  }
})

let billsToSend = []

sgMail.setApiKey(process.env.SENDGRID_API_KEY)

function parseMonthYear(data, prefix='_') {
  const months = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ']

  const [year, month] = data.split(prefix)
  const index = parseInt(month, 10) - 1

  if (index < 0 || index > 11 || !year) {
    return 'DATA INVÁLIDA'
  }

  return `${months[index]}/${year}`
}

async function withRetry(fn, options = {}) {
  const {
    maxRetries = 5,
    delayMs = 15000,
    onRetry = (err, attempt) => {
      console.log(`Tentativa ${attempt} falhou: ${err.message}`)
    },
  } = options

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      onRetry(err, attempt)
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastError
}

async function getUsers() {
    const res = await axios.get(`${process.env.API_BASE_URL}/users/list`)

    const { users } = res.data

    if (users && users.data)
        return users.data

    return []
}

async function savePdf(pdfUrl, prefix='', installation='', type='', paid=false) {
    if (!installation) return 'Error: User name is required'
    
    const typeToUse = type || 'outro'

    const prefixToUse = prefix || Date.now()

    const downloadPath = paid ? path.resolve(__dirname, "tmp", "pago", typeToUse, installation) : path.resolve(__dirname, "tmp", "aberto", typeToUse, installation)

    await fsPromise.mkdir(downloadPath, { recursive: true })

    const savePath = path.join(downloadPath, `${prefixToUse}.pdf`)

    console.log("Downloading PDF...")

    await new Promise((resolve, reject) => {
      https.get(pdfUrl, (response) => {
        reject(new Error("test"))
        if (response.statusCode !== 200) {
          reject(new Error(`Error while downloading PDF. Status code: ${response.statusCode}`))
          return
        }
        const fileStream = fs.createWriteStream(savePath)
        response.pipe(fileStream)
        fileStream.on('finish', () => {
          fileStream.close()
          console.log(`Download completed: ${savePath}`)
          resolve()
        })
      }).on('error', (err) => reject(err))
    })
}

function encrypt(text) {
  const cipher = crypto.createCipheriv('aes-256-cbc', ENCRYPTION_KEY, IV)
  let encrypted = cipher.update(text)
  encrypted = Buffer.concat([encrypted, cipher.final()])
  return encrypted.toString('hex')
}

function decrypt(encryptedText) {
  const encryptedBuffer = Buffer.from(encryptedText, 'hex')
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENCRYPTION_KEY, IV)
  let decrypted = decipher.update(encryptedBuffer)
  decrypted = Buffer.concat([decrypted, decipher.final()])
  return decrypted.toString('utf8')
}

function sleep(delay) {
  return new Promise((resolve) => setTimeout(resolve, delay))
} 

async function downloadEnergyBill(email, password, installation, userId, type, paid=false) {
    if (!email) return 'Error: Email is required'
    if (!password) return 'Error: Password is required'
    if (!installation) return 'Error: Installation is required'
    if (!userId) return 'Error: Nome usuario is required'

    let page

    try {
      if (browser) {
        try {
          await browser.close()
          console.log('Past browser closed.')
        } catch (err) {
          console.warn('Error while trying close past browser:', err.message)
        }
      }

      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--window-size=1920,1080", "--disable-blink-features=AutomationControlled"]
      })

      page = await browser.newPage()
      await page.setViewport({ width: 1920, height: 1080 })
      await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0 Win64 x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
      await page.evaluate(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined })
      })
      page.setDefaultTimeout(90000)

      console.log('------------------------------------------------------------------------')
      console.log('Auth on cpfl...', { email, installation, userId, type })

      await page.goto(`${process.env.CPFL_BASE_URL}/b2c-auth/login`, { waitUntil: "networkidle2", timeout: 120000 })
      await page.waitForSelector("#signInName", { timeout: 15000 })
      await page.type("#signInName", email, { delay: 50 })
      await page.type("#password", password, { delay: 50 })
      await page.click("#next")
      console.log("Clicked on login button...")
      await page.waitForNavigation()
      await page.waitForNetworkIdle()

        try {
            await page.waitForSelector('#onetrust-accept-btn-handler', { visible: true })

            await page.click('#onetrust-accept-btn-handler')

            const element = await page.waitForSelector('.save-preference-btn-handler', { timeout: 3000 })

            if (element) {
                console.log('Accept cookies...')
                await page.click('.save-preference-btn-handler')
            }
        } catch (err) {
            console.log('No cookies to accept found.')
        } finally { 
                try {
                    const element3 = await page.waitForSelector(`#instalacao-${installation}`, { timeout: 3000 })
                    
                    if (element3) {
                        console.log('Select installation...')
                        await page.click(`#instalacao-${installation}`)
                
                        await page.click('#btn-buscar')

                        await page.waitForNavigation()
            
                        await page.waitForNetworkIdle()
                    }
                } catch (err) {
                  throw err
                } finally {
                  try {
                    console.log('Redirect to 2 via page...')
                    await page.goto(`${process.env.CPFL_BASE_URL}/cpfl-auth/redirect-arame-servicos?servico=historico-de-contas-antigo`)

                    console.log('Getting requests')

                    const paidPromise = paid
                      ? page.waitForResponse(
                          res => res.url().includes('/contas-quitadas') && res.status() === 200,
                          { timeout: 30000 }
                        ).then(async res => {
                          const data = await res.json()
                          return data.ContasPagas || []
                        }).catch(() => [])
                      : Promise.resolve([])

                    const openPromise = page.waitForResponse(
                      res => res.url().includes('/validar-situacao') && res.status() === 200,
                      { timeout: 30000 }
                    ).then(async res => {
                      const data = await res.json()
                      return data.ContasAberto || []
                    }).catch(() => [])

                    const [paidOffBills, openBills] = await Promise.all([paidPromise, openPromise])

                    console.log('paidOfBills qtty: ', paidOffBills.length)
                    console.log('openBills qtty: ', openBills.length)

                    console.log('Getting payload...')
                    const userSessionStorage = await page.evaluate(() => sessionStorage.getItem("userSessionStorage"))

                    const installSessionStorage = await page.evaluate(() => sessionStorage.getItem("instalacaoSessionStorage"))

                    if (paid && paidOffBills && paidOffBills.length) {
                      console.log("-----Starting download paid off bills...-----")
                      const downloadPromises = []
                  
                      for (const paidOffBill of paidOffBills) {
                          if (paidOffBill?.NumeroContaEnergia) {
                              let alreadyOnDb = false
                  
                              const res = await axios.get(`${process.env.API_BASE_URL}/energy-bills/list`, {
                                  params: {
                                      search: JSON.stringify({ operacao_mes: `${paidOffBill.NumeroContaEnergia}-${parseMonthYear(paidOffBill.MesReferencia, '/')}` })
                                  }
                              })
                  
                              if (res?.data?.energyBills?.data?.length) {
                                  alreadyOnDb = true
                                  console.log('Paid of bill already on database', { NumeroContaEnergia: paidOffBill.NumeroContaEnergia })
                              }
                  
                              const payload = {
                                  numeroContaEnergia: paidOffBill.NumeroContaEnergia,
                                  contaAcumulada: paidOffBill.ContaAcumulada || false,
                                  token: userSessionStorage && JSON.parse(userSessionStorage).access_token || '',
                                  parceiroNegocio: installSessionStorage && JSON.parse(installSessionStorage).ParceiroNegocio || '',
                                  instalacao: installSessionStorage && JSON.parse(installSessionStorage).Instalacao || '',
                                  codEmpresaSAP: installSessionStorage && JSON.parse(installSessionStorage).CodEmpresaSAP || '',
                                  codigoClasse: installSessionStorage && JSON.parse(installSessionStorage).CodigoClasse || '',
                              }
                  
                              const pdfUrl = `${process.env.CPFL_PDF_BASE_URL}/conta-completa?numeroContaEnergia=${payload.numeroContaEnergia}&contaAcumulada=${payload.contaAcumulada}&token=${payload.token}&parceiroNegocio=${payload.parceiroNegocio}&instalacao=${payload.instalacao}&codEmpresaSAP=${payload.codEmpresaSAP}&codigoClasse=${payload.codigoClasse}`
                  
                              const pathName = `${userId}-${paidOffBill.MesReferencia.replace('/', '_')}-${alreadyOnDb ? '1' : '0'}-${paidOffBill.NumeroContaEnergia}`
                  
                              downloadPromises.push(savePdf(pdfUrl, pathName, installation, type, true).catch(err => { throw err }))
                          }
                      }
                      try {
                        await Promise.all(downloadPromises)
                      } catch (err) {
                        throw err
                      }
                      
                  }

                    if (paid && (!paidOffBills || !paidOffBills.length)) console.log('No paid off bills to save found.', {email, installation, userId, type})

                      if (openBills && openBills.length) {
                        console.log("-----Starting download open bills...-----")
                        const downloadPromises = []
                    
                        for (const bill of openBills) {
                            if (bill?.NumeroContaEnergia) {
                                let alreadyOnDb = false
                    
                                const res = await axios.get(`${process.env.API_BASE_URL}/energy-bills/list`, {
                                    params: {
                                        search: JSON.stringify({ operacao_mes: `${bill.NumeroContaEnergia}-${parseMonthYear(bill.MesReferencia, '/')}` })
                                    }
                                })
                    
                                if (res?.data?.energyBills?.data?.length) {
                                    alreadyOnDb = true
                                    console.log('Bill already on database', { NumeroContaEnergia: bill.NumeroContaEnergia })
                                }
                    
                                const payload = {
                                    numeroContaEnergia: bill.NumeroContaEnergia,
                                    contaAcumulada: bill.ContaAcumulada || false,
                                    token: userSessionStorage && JSON.parse(userSessionStorage).access_token || '',
                                    parceiroNegocio: installSessionStorage && JSON.parse(installSessionStorage).ParceiroNegocio || '',
                                    instalacao: installSessionStorage && JSON.parse(installSessionStorage).Instalacao || '',
                                    codEmpresaSAP: installSessionStorage && JSON.parse(installSessionStorage).CodEmpresaSAP || '',
                                    codigoClasse: installSessionStorage && JSON.parse(installSessionStorage).CodigoClasse || '',
                                }
                    
                                const pdfUrl = `${process.env.CPFL_PDF_BASE_URL}/conta-completa-pdf?numeroContaEnergia=${payload.numeroContaEnergia}&contaAcumulada=${payload.contaAcumulada}&token=${payload.token}&parceiroNegocio=${payload.parceiroNegocio}&instalacao=${payload.instalacao}&codEmpresaSAP=${payload.codEmpresaSAP}&codigoClasse=${payload.codigoClasse}`
                    
                                const pathName = `${userId}-${bill.MesReferencia.replace('/', '_')}-${alreadyOnDb ? '1' : '0'}-${bill.NumeroContaEnergia}`
                    
                                downloadPromises.push(savePdf(pdfUrl, pathName, installation, type, false).catch(err => { throw err }))
                            }
                        }
                        try {
                          await Promise.all(downloadPromises)
                        } catch(err) {
                          throw err
                        }
                    } else {
                        console.log('No open bills to save found.', { email, installation, userId, type })
                    }
                  } catch (err) {
                    console.log("Error while downloading pdfs")
                    throw err
                  }
                }
        }
    } catch (error) {
        console.error("Error on puppeteer", error)
        throw error
    }

    if (browser) await browser.close()
    console.log("Waiting before continue...")
    await sleep(20000)
    
}

function getDataId(fileName) {
  const [id, data, alreadyOnDb, operacao] = fileName.replace('.pdf', '').split('-')

  return { id, data, alreadyOnDb, operacao }
}
  
async function getRelations(inquilinoId, tenantsPlants=[]) {
  try {
    return tenantsPlants.filter(f => String(f.inquilino_id) === String(inquilinoId))
  } catch (err) {
    console.error(`Erro ao buscar relacionamentos do inquilino ${inquilinoId}:`, err.message)
    return []
  }
}

async function getTenantsPlants() {
    try {
    const res = await axios.get(`${process.env.API_BASE_URL}/tenants-plants/list`)
    return res.data && res.data.tenantsPlants || []
  } catch (err) {
    console.error(`Erro ao buscar relacionamentos do inquilino ${inquilinoId}:`, err.message)
    return []
  }
}
  
function getPlantBills(usinaId, data, basePath, taxaSoluttion) {
  const statuses = ['aberto', 'pago']
  const result = []

  statuses.forEach(status => {
    const plantFolder = path.join(basePath, status, 'usina')
    if (!fs.existsSync(plantFolder)) return

    const subFolders = fs.readdirSync(plantFolder)

    subFolders.forEach(sub => {
      const subPath = path.join(plantFolder, sub)
      if (!fs.statSync(subPath).isDirectory()) return

      const files = fs.readdirSync(subPath)

      files.forEach(file => {
        const name = `${usinaId}-${data}`
        if (file.startsWith(name) && file.endsWith('.pdf')) {
          const filePath = path.join(subPath, file)
          const { id, data, alreadyOnDb, operacao } = getDataId(file)
          result.push({
            estado: status,
            nome: file,
            id: usinaId,
            caminho: filePath,
            data,
            alreadyOnDb,
            operacao,
            taxaSoluttion
          })
        }
      })
    })
  })

  return result
}
  
async function groupBills(basePath) {
  console.log("Starting grouping bills")
  const tenantsPlants = await getTenantsPlants()
  const allUsers = await getUsers()
  const statuses = ['aberto', 'pago']
  const finalResult = []

  for (const status of statuses) {
    const inquilinoPath = path.join(basePath, status, 'inquilino')
    if (!fs.existsSync(inquilinoPath)) continue

    const folders = fs.readdirSync(inquilinoPath)
    for (const sub of folders) {
      const subPath = path.join(inquilinoPath, sub)
      if (!fs.statSync(subPath).isDirectory()) continue

      const files = fs.readdirSync(subPath)
      for (const file of files) {
        if (!file.endsWith('.pdf')) continue

        const { id: inquilinoId, data, alreadyOnDb, operacao } = getDataId(file)
        const filePath = path.join(subPath, file)

        let user = allUsers.find(u => String(u.id) === String(inquilinoId))

        const inquilino = {
          estado: status,
          nome: file,
          id: inquilinoId,
          data,
          caminho: filePath,
          alreadyOnDb,
          operacao,
          porcentagemContratual: user && Number(user.porcentagem_contrato)
        }

        let relations = []
        try {
          relations = await getRelations(inquilinoId, tenantsPlants)
        } catch (err) {
          console.error(`Error while searching relations for inquilino ${inquilinoId}:`, err.message)
          continue
        }

        const usinas = []
        for (const rel of relations) {
          const plantsFounded = getPlantBills(rel.usina_id, data, basePath, Number(rel.usina.taxa_soluttion))
          usinas.push(...plantsFounded)
        }

        finalResult.push({ inquilino, usinas, relations })
      }
    }
  }

  console.log("Done grouping bills")
  return finalResult
}

function renameWithInsertedFile(oldPath) {
  const oldName = path.basename(oldPath)
  const dir = path.dirname(oldPath)

  if (!oldName.includes('-0-')) {
    console.log(`File ${oldName} does not have marker '-0-'`)
    return oldPath
  }

  if (!fs.existsSync(oldPath)) {
    console.log(`File not found to rename: ${oldPath}`)
    return oldPath
  }

  const newName = oldName.replace('-0-', '-1-')
  const newPath = path.join(dir, newName)

  fs.renameSync(oldPath, newPath)
  return newPath
}

function openFileWithCallback(originalPath) {
  const originalName = path.basename(originalPath)
  const dir = path.dirname(originalPath)

  if (fs.existsSync(originalPath)) {
    const inserted = originalName.includes('-1-') ? '1' : '0'
    return {
      stream: fs.createReadStream(originalPath),
      caminho: originalPath,
      inserted
    }
  }

  let altName

  if (originalName.includes('-0-')) {
    altName = originalName.replace('-0-', '-1-')
  } else if (originalName.includes('-1-')) {
    altName = originalName.replace('-1-', '-0-')
  } else {
    throw new Error(`File not found: ${originalName}`)
  }

  const altPath = path.join(dir, altName)

  if (fs.existsSync(altPath)) {
    const inserted = altName.includes('-1-') ? '1' : '0'
    console.warn(`Alternative path used: ${altPath}`)
    return {
      stream: fs.createReadStream(altPath),
      caminho: altPath,
      inserted
    }
  }

  throw new Error(`File not found: ${originalPath} / ${altPath}`)
}

async function sendBillsToWebhook(groups) {
  const url = process.env.N8N_URL

  for (const group of groups) {
    console.log('-----------------------------------------')
    if ((group.inquilino.alreadyOnDb && Number(group.inquilino.alreadyOnDb) === 0) && (group.usinas && group.relations && group.usinas.length === group.relations.length)) {
      console.log('Sending data for inquilino: ', group.inquilino.id)
      const form = new FormData()
  
      console.log('inquilino', group.inquilino.nome)
      const inqName = `inquilino-${group.inquilino.id}-${group.inquilino.porcentagemContratual}-${group.inquilino.alreadyOnDb}-${group.inquilino.operacao}`
      form.append(inqName, fs.createReadStream(group.inquilino.caminho), {
        filename: group.inquilino.nome,
        contentType: 'application/pdf'
      })
  
      group.usinas.forEach(usina => {
        console.log('usina', usina.nome)
        const usFile = openFileWithCallback(usina.caminho)
        const usName = `usina-${usina.id}-${usina.taxaSoluttion}-${usFile.inserted}-${usina.operacao}`
        form.append(usName, usFile.stream, {
          filename: usina.nome,
          contentType: 'application/pdf'
        })
      })
  
      try {
        const response = await axios.post(url, form, {
          headers: form.getHeaders()
        }, {
          timeout: 5 * 60 * 1000,
        })
  
        if (response.status >= 200 && response.status < 300) {
          console.log(`Successfully sent to tenant ${group.inquilino.id}.`)

          group.inquilino.caminho = renameWithInsertedFile(group.inquilino.caminho)

          group.usinas.map(usina => ({
            ...usina,
            caminho: renameWithInsertedFile(usina.caminho)
          }))

          billsToSend.push(group.inquilino)

          group.usinas.map(usina => {
            if (!billsToSend.find(b => b.operacao === usina.operacao)) {
              billsToSend.push(usina)
            }
          })
        } else {
          console.log(`Failure on send to tenant ${group.inquilino.id}. Files kept.`)
        }
      } catch (err) {
        console.log(`Error on send to tenant ${group.inquilino.id}:`, err.message)
        if (err && err.response && err.response.data) {
          console.log(err.response.data)
        }
      }
    } else {
      if (group.inquilino.alreadyOnDb && Number(group.inquilino.alreadyOnDb) === 1)
        console.log('Inquilino bill already on database: ', { file: group.inquilino.nome })
      else if (!group.usinas || !group.relations || group.usinas.length !== group.relations.length) {
        console.log('Inquilino with different number of usinas: ', { file: group.inquilino.nome, usinas: group.usinas })
        group.inquilino.caminho = renameWithInsertedFile(group.inquilino.caminho)
      }
      else
        console.log('Error on inquilino: ', { file: group.inquilino.nome })
    }
  }
}

function removeInsertedFiles(basePath) {
  const statuses = ['aberto', 'pago']

  statuses.forEach(status => {
    const inquilinoPath = path.join(basePath, status, 'inquilino')
    if (!fs.existsSync(inquilinoPath)) return

    const subFolders = fs.readdirSync(inquilinoPath)

    subFolders.forEach(sub => {
      const id = path.join(inquilinoPath, sub)
      if (!fs.statSync(id).isDirectory()) return

      const files = fs.readdirSync(id)

      files.forEach(file => {
        const filePath = path.join(id, file)

        if (file.endsWith('.pdf') && file.includes('-1-')) {
          try {
            fs.unlinkSync(filePath)
            console.log(`Removed file: ${filePath}`)
          } catch (err) {
            console.error(`Error on remove ${filePath}:`, err.message)
          }
        }
      })
    })
  })
}

function havePendingInquilinos(basePath) {
  const statuses = ['aberto', 'pago']

  for (const status of statuses) {
    const inquilinoPath = path.join(basePath, status, 'inquilino')
    if (!fs.existsSync(inquilinoPath)) continue

    const subFolders = fs.readdirSync(inquilinoPath)
    for (const sub of subFolders) {
      const subPath = path.join(inquilinoPath, sub)
      if (!fs.statSync(subPath).isDirectory()) continue

      const files = fs.readdirSync(subPath)
      if (files.some(f => f.includes('-0-') && f.endsWith('.pdf'))) {
        return true
      }
    }
  }

  return false
}

function removeUsinasIfNotPendingInquilinos(basePath) {
  const havePending = havePendingInquilinos(basePath)

  if (havePending) {
    console.log('Have pending inquilinos. Kept usina files.')
    return
  }

  console.log('All inquilinos inserted, removing usinas files.')

  const statuses = ['aberto', 'pago']

  statuses.forEach(status => {
    const usinaPath = path.join(basePath, status, 'usina')
    if (!fs.existsSync(usinaPath)) return

    const subFolders = fs.readdirSync(usinaPath)
    subFolders.forEach(sub => {
      const subPath = path.join(usinaPath, sub)
      if (!fs.statSync(subPath).isDirectory()) return

      const files = fs.readdirSync(subPath)
      files.forEach(file => {
        if (file.endsWith('.pdf') && file.includes('-1-')) {
          const filePath = path.join(subPath, file)
          try {
            fs.unlinkSync(filePath)
            console.log(`Removed usina: ${filePath}`)
          } catch (err) {
            console.error(`Error on remove ${filePath}:`, err.message)
          }
        }
      })
    })
  })
}

async function downloadAllUsersEnergyBills() {
    const users = await getUsers()

    const decryptedPassword = process.env.CPFL_PASSWORD ? decrypt(process.env.CPFL_PASSWORD) : ''
    
    for (const user of users) {
      try {
        await withRetry(async () => {
        await downloadEnergyBill(
          process.env.CPFL_EMAIL,
          decryptedPassword,
          user.id_usuario,
          user.id,
          user.tipo,
          true
        )
      }, {
        maxRetries: 3,
        delayMs: 15000,
        onRetry: (err, attempt) => {
          console.log(`[Global try for user ${user.id}, try number ${attempt}] ${err.message}`)
        }
      })
      } catch(err) {
        console.log(`All attempts failed for user ${user.id}. Skipping for the next.`)
      }
    }

    console.log('Done downloading energy bills...')
}

const basePath = path.join(__dirname, 'tmp')

async function sendEnergyBillsToN8n() {
  console.log('Starting send energy bills to N8N...')
  const groups = await groupBills(basePath)
  await sendBillsToWebhook(groups)
  console.log('Done upload files to n8n...')
}

async function sendMail(bills=[]) {
  const energyBillsNumbers = []

  for (const b of bills) {
    if (b && b.operacao && b.data) {
      const operacao_mes = `${b.operacao}-${parseMonthYear(b.data)}`

      const res = await axios.get(`${process.env.API_BASE_URL}/energy-bills/list`, {
        params: {
          search: JSON.stringify({ operacao_mes })
        }
      })

      const { energyBills } = res.data

      if (energyBills && energyBills.data && energyBills.data.length) {
        const { tipo, fatura_numero, Usuarios, usinas } = energyBills.data[0]

        const name = tipo.includes("inquilino") ? Usuarios.nome : usinas.nome

        energyBillsNumbers.push({ fatura_numero, name })
      }
    }
  }

  if (energyBillsNumbers.length) {
    let html = '<p><strong>Faturas inseridas:</strong></p>'
  
    energyBillsNumbers.map(e => {
      html += `<p>${e.name} - ${process.env.CLIENT_BASE_URL}/${e.fatura_numero}</p>`
    })
  
    const msg = {
      to: process.env.MAIL_TO,
      from: process.env.MAIL_FROM,
      subject: 'Faturas inseridas no sistema',
      html,
    }
    sgMail
      .send(msg)
      .then(() => {
        console.log('Email sent')
      })
      .catch((error) => {
        console.error(error)
      }) 
  }

}

async function main() {
  try {
    await downloadAllUsersEnergyBills()

    let retrys = 1
    while (havePendingInquilinos(basePath) && retrys <= 3) {
      console.log(`Try number ${retrys}...`)
      await sendEnergyBillsToN8n()
      removeInsertedFiles(basePath)
      removeUsinasIfNotPendingInquilinos(basePath)
      retrys++
    }


    await sendMail(billsToSend)

    billsToSend = []

    console.log('Flow finished.')
  } catch(err) {
    console.error("error on main flow: ", err)
  } finally {
    process.exit(0)
  }
}

await main()


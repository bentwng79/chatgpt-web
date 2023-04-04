import * as fs from 'fs'
import * as path from 'path'
import nodemailer from 'nodemailer'
import type { MailConfig } from '../storage/model'
import { getCacheConfig } from '../storage/config'

export async function sendVerifyMail(toMail: string, verifyUrl: string) {
  const config = (await getCacheConfig())

  const templatesPath = path.join(__dirname, 'templates')
  const mailTemplatePath = path.join(templatesPath, 'mail.template.html')
  let mailHtml = fs.readFileSync(mailTemplatePath, 'utf8')
  mailHtml = mailHtml.replace(/\${VERIFY_URL}/g, verifyUrl)
  mailHtml = mailHtml.replace(/\${SITE_TITLE}/g, config.siteConfig.siteTitle)
  sendMail(toMail, `${config.siteConfig.siteTitle} 賬號驗證`, mailHtml, config.mailConfig)
}

export async function sendTestMail(toMail: string, config: MailConfig) {
  return sendMail(toMail, '測試郵件|Test mail', '這是一封測試郵件|This is test mail', config)
}

async function sendMail(toMail: string, subject: string, html: string, config: MailConfig) {
  const mailOptions = {
    from: config.smtpUserName,
    to: toMail,
    subject,
    html,
  }

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpTsl,
    auth: {
      user: config.smtpUserName,
      pass: config.smtpPassword,
    },
  })
  const info = await transporter.sendMail(mailOptions)
  return info.messageId
}

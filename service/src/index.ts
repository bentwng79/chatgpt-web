import express from 'express'
import jwt from 'jsonwebtoken'
import * as dotenv from 'dotenv'
import { ObjectId } from 'mongodb'
import { textTokens } from 'gpt-token'
import speakeasy from 'speakeasy'
import { type RequestProps, TwoFAConfig } from './types'
import type { ChatMessage } from './chatgpt'
import { abortChatProcess, chatConfig, chatReplyProcess, containsSensitiveWords, initAuditService } from './chatgpt'
import { auth, getUserId } from './middleware/auth'
import { clearApiKeyCache, clearConfigCache, getApiKeys, getCacheApiKeys, getCacheConfig, getOriginConfig } from './storage/config'
import type { AuditConfig, ChatInfo, ChatOptions, Config, KeyConfig, MailConfig, SiteConfig, UserConfig, UserInfo } from './storage/model'
import { Status, UsageResponse, UserRole } from './storage/model'
import {
  clearChat,
  createChatRoom,
  createUser,
  deleteAllChatRooms,
  deleteChat,
  deleteChatRoom,
  disableUser2FA,
  existsChatRoom,
  getChat,
  getChatRoom,
  getChatRooms,
  getChats,
  getUser,
  getUserById,
  getUserStatisticsByDay,
  getUsers,
  insertChat,
  insertChatUsage,
  renameChatRoom,
  updateApiKeyStatus,
  updateChat,
  updateConfig,
  updateRoomChatModel,
  updateRoomPrompt,
  updateRoomUsingContext,
  updateUser,
  updateUser2FA,
  updateUserChatModel,
  updateUserInfo,
  updateUserPassword,
  updateUserPasswordWithVerifyOld,
  updateUserStatus,
  upsertKey,
  verifyUser,
} from './storage/mongo'
import { authLimiter, limiter } from './middleware/limiter'
import { hasAnyRole, isEmail, isNotEmptyString } from './utils/is'
import { sendNoticeMail, sendResetPasswordMail, sendTestMail, sendVerifyMail, sendVerifyMailAdmin } from './utils/mail'
import { checkUserResetPassword, checkUserVerify, checkUserVerifyAdmin, getUserResetPasswordUrl, getUserVerifyUrl, getUserVerifyUrlAdmin, md5 } from './utils/security'
import { rootAuth } from './middleware/rootAuth'

dotenv.config()

const app = express()
const router = express.Router()

app.use(express.static('public'))
app.use(express.json())

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'authorization, Content-Type')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

router.get('/chatrooms', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const rooms = await getChatRooms(userId)
    const result = []
    rooms.forEach((r) => {
      result.push({
        uuid: r.roomId,
        title: r.title,
        isEdit: false,
        prompt: r.prompt,
        usingContext: r.usingContext === undefined ? true : r.usingContext,
        chatModel: r.chatModel,
      })
    })
    res.send({ status: 'Success', message: null, data: result })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Load error', data: [] })
  }
})

router.post('/room-create', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { title, roomId } = req.body as { title: string; roomId: number }
    const room = await createChatRoom(userId, title, roomId)
    res.send({ status: 'Success', message: null, data: room })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Create error', data: null })
  }
})

router.post('/room-rename', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { title, roomId } = req.body as { title: string; roomId: number }
    const room = await renameChatRoom(userId, title, roomId)
    res.send({ status: 'Success', message: null, data: room })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Rename error', data: null })
  }
})

router.post('/room-prompt', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { prompt, roomId } = req.body as { prompt: string; roomId: number }
    const success = await updateRoomPrompt(userId, roomId, prompt)
    if (success)
      res.send({ status: 'Success', message: 'Saved successfully', data: null })
    else
      res.send({ status: 'Fail', message: 'Failed to save', data: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Rename error', data: null })
  }
})

router.post('/room-chatmodel', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { chatModel, roomId } = req.body as { chatModel: string; roomId: number }
    const success = await updateRoomChatModel(userId, roomId, chatModel)
    if (success)
      res.send({ status: 'Success', message: 'Saved successfully', data: null })
    else
      res.send({ status: 'Fail', message: 'Failed to save', data: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Rename error', data: null })
  }
})

router.post('/room-context', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { using, roomId } = req.body as { using: boolean; roomId: number }
    const success = await updateRoomUsingContext(userId, roomId, using)
    if (success)
      res.send({ status: 'Success', message: 'Saved successfully', data: null })
    else
      res.send({ status: 'Fail', message: 'Failed to save', data: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Rename error', data: null })
  }
})

router.post('/room-delete', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { roomId } = req.body as { roomId: number }
    if (!roomId || !await existsChatRoom(userId, roomId)) {
      res.send({ status: 'Fail', message: 'Unknown room', data: null })
      return
    }
    await deleteChatRoom(userId, roomId)
    res.send({ status: 'Success', message: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Delete error', data: null })
  }
})

router.get('/chat-history', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const roomId = +req.query.roomId
    const lastId = req.query.lastId as string
    if (!roomId || !await existsChatRoom(userId, roomId)) {
      res.send({ status: 'Success', message: null, data: [] })
      // res.send({ status: 'Fail', message: 'Unknown room', data: null })
      return
    }
    const chats = await getChats(roomId, !isNotEmptyString(lastId) ? null : parseInt(lastId))

    const result = []
    chats.forEach((c) => {
      if (c.status !== Status.InversionDeleted) {
        result.push({
          uuid: c.uuid,
          dateTime: new Date(c.dateTime).toLocaleString(),
          text: c.prompt,
          inversion: true,
          error: false,
          conversationOptions: null,
          requestOptions: {
            prompt: c.prompt,
            options: null,
          },
        })
      }
      if (c.status !== Status.ResponseDeleted) {
        const usage = c.options.completion_tokens
          ? {
              completion_tokens: c.options.completion_tokens || null,
              prompt_tokens: c.options.prompt_tokens || null,
              total_tokens: c.options.total_tokens || null,
              estimated: c.options.estimated || null,
            }
          : undefined
        result.push({
          uuid: c.uuid,
          dateTime: new Date(c.dateTime).toLocaleString(),
          text: c.response,
          inversion: false,
          error: false,
          loading: false,
          responseCount: (c.previousResponse?.length ?? 0) + 1,
          conversationOptions: {
            parentMessageId: c.options.messageId,
            conversationId: c.options.conversationId,
          },
          requestOptions: {
            prompt: c.prompt,
            parentMessageId: c.options.parentMessageId,
            options: {
              parentMessageId: c.options.messageId,
              conversationId: c.options.conversationId,
            },
          },
          usage,
        })
      }
    })

    res.send({ status: 'Success', message: null, data: result })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Load error', data: null })
  }
})

router.get('/chat-response-history', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const roomId = +req.query.roomId
    const uuid = +req.query.uuid
    const index = +req.query.index
    if (!roomId || !await existsChatRoom(userId, roomId)) {
      res.send({ status: 'Success', message: null, data: [] })
      // res.send({ status: 'Fail', message: 'Unknown room', data: null })
      return
    }
    const chat = await getChat(roomId, uuid)
    if (chat.previousResponse === undefined || chat.previousResponse.length < index) {
      res.send({ status: 'Fail', message: 'Error', data: [] })
      return
    }
    const response = index >= chat.previousResponse.length
      ? chat
      : chat.previousResponse[index]
    const usage = response.options.completion_tokens
      ? {
          completion_tokens: response.options.completion_tokens || null,
          prompt_tokens: response.options.prompt_tokens || null,
          total_tokens: response.options.total_tokens || null,
          estimated: response.options.estimated || null,
        }
      : undefined
    res.send({
      status: 'Success',
      message: null,
      data: {
        uuid: chat.uuid,
        dateTime: new Date(chat.dateTime).toLocaleString(),
        text: response.response,
        inversion: false,
        error: false,
        loading: false,
        responseCount: (chat.previousResponse?.length ?? 0) + 1,
        conversationOptions: {
          parentMessageId: response.options.messageId,
          conversationId: response.options.conversationId,
        },
        requestOptions: {
          prompt: chat.prompt,
          parentMessageId: response.options.parentMessageId,
          options: {
            parentMessageId: response.options.messageId,
            conversationId: response.options.conversationId,
          },
        },
        usage,
      },
    })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Load error', data: null })
  }
})

router.post('/chat-delete', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { roomId, uuid, inversion } = req.body as { roomId: number; uuid: number; inversion: boolean }
    if (!roomId || !await existsChatRoom(userId, roomId)) {
      res.send({ status: 'Fail', message: 'Unknown room', data: null })
      return
    }
    await deleteChat(roomId, uuid, inversion)
    res.send({ status: 'Success', message: null, data: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Delete error', data: null })
  }
})

router.post('/chat-clear-all', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    await deleteAllChatRooms(userId)
    res.send({ status: 'Success', message: null, data: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Delete error', data: null })
  }
})

router.post('/chat-clear', auth, async (req, res) => {
  try {
    const userId = req.headers.userId as string
    const { roomId } = req.body as { roomId: number }
    if (!roomId || !await existsChatRoom(userId, roomId)) {
      res.send({ status: 'Fail', message: 'Unknown room', data: null })
      return
    }
    await clearChat(roomId)
    res.send({ status: 'Success', message: null, data: null })
  }
  catch (error) {
    console.error(error)
    res.send({ status: 'Fail', message: 'Delete error', data: null })
  }
})

router.post('/chat-process', [auth, limiter], async (req, res) => {
  res.setHeader('Content-type', 'application/octet-stream')

  let { roomId, uuid, regenerate, prompt, options = {}, systemMessage, temperature, top_p } = req.body as RequestProps
  const userId = req.headers.userId as string
  const room = await getChatRoom(userId, roomId)
  if (room == null)
    global.console.error(`Unable to get chat room \t ${userId}\t ${roomId}`)
  if (room != null && isNotEmptyString(room.prompt))
    systemMessage = room.prompt
  let lastResponse
  let result
  let message: ChatInfo
  try {
    const config = await getCacheConfig()
    const userId = req.headers.userId.toString()
    const user = await getUserById(userId)
    if (config.auditConfig.enabled || config.auditConfig.customizeEnabled) {
      if (!user.roles.includes(UserRole.Admin) && await containsSensitiveWords(config.auditConfig, prompt)) {
        res.send({ status: 'Fail', message: '含有敏感詞 | Contains sensitive words', data: null })
        return
      }
    }

    message = regenerate
      ? await getChat(roomId, uuid)
      : await insertChat(uuid, prompt, roomId, options as ChatOptions)
    let firstChunk = true
    result = await chatReplyProcess({
      message: prompt,
      lastContext: options,
      process: (chat: ChatMessage) => {
        lastResponse = chat
        const chuck = {
          id: chat.id,
          conversationId: chat.conversationId,
          text: chat.text,
          detail: {
            choices: [
              {
                finish_reason: undefined,
              },
            ],
          },
        }
        if (chat.detail && chat.detail.choices.length > 0)
          chuck.detail.choices[0].finish_reason = chat.detail.choices[0].finish_reason

        res.write(firstChunk ? JSON.stringify(chuck) : `\n${JSON.stringify(chuck)}`)
        firstChunk = false
      },
      systemMessage,
      temperature,
      top_p,
      user,
      messageId: message._id.toString(),
      tryCount: 0,
      room,
    })
    // return the whole response including usage
    if (!result.data.detail?.usage) {
      if (!result.data.detail)
        result.data.detail = {}
      result.data.detail.usage = new UsageResponse()
      // 因为 token 本身不计算, 所以这里默认以 gpt 3.5 的算做一个伪统计
      result.data.detail.usage.prompt_tokens = textTokens(prompt, 'gpt-3.5-turbo')
      result.data.detail.usage.completion_tokens = textTokens(result.data.text, 'gpt-3.5-turbo')
      result.data.detail.usage.total_tokens = result.data.detail.usage.prompt_tokens + result.data.detail.usage.completion_tokens
      result.data.detail.usage.estimated = true
    }
    res.write(`\n${JSON.stringify(result.data)}`)
  }
  catch (error) {
    res.write(JSON.stringify({ message: error?.message }))
  }
  finally {
    res.end()
    try {
      if (result == null || result === undefined || result.status !== 'Success') {
        if (result && result.status !== 'Success')
          lastResponse = { text: result.message }
        result = { data: lastResponse }
      }

      if (result.data === undefined)
        // eslint-disable-next-line no-unsafe-finally
        return

      if (regenerate && message.options.messageId) {
        const previousResponse = message.previousResponse || []
        previousResponse.push({ response: message.response, options: message.options })
        await updateChat(message._id as unknown as string,
          result.data.text,
          result.data.id,
          result.data.conversationId,
          result.data.detail?.usage as UsageResponse,
          previousResponse as [])
      }
      else {
        await updateChat(message._id as unknown as string,
          result.data.text,
          result.data.id,
          result.data.conversationId,
          result.data.detail?.usage as UsageResponse)
      }

      if (result.data.detail?.usage) {
        await insertChatUsage(new ObjectId(req.headers.userId),
          roomId,
          message._id,
          result.data.id,
          result.data.detail?.usage as UsageResponse)
      }
    }
    catch (error) {
      global.console.error(error)
    }
  }
})

router.post('/chat-abort', [auth, limiter], async (req, res) => {
  try {
    const userId = req.headers.userId.toString()
    const { text, messageId, conversationId } = req.body as { text: string; messageId: string; conversationId: string }
    const msgId = await abortChatProcess(userId)
    await updateChat(msgId,
      text,
      messageId,
      conversationId,
      null)
    res.send({ status: 'Success', message: 'OK', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: '無法中止聊天。 | Failed to abort chat.', data: null })
  }
})

router.post('/user-register', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body as { username: string; password: string }
    const config = await getCacheConfig()
    if (!config.siteConfig.registerEnabled) {
      res.send({ status: 'Fail', message: '註冊賬號功能未啟用 | User signup disabled', data: null })
      return
    }
    if (!isEmail(username)) {
      res.send({ status: 'Fail', message: '請輸入正確的郵箱 | Please enter a valid email address', data: null })
      return
    }
    if (isNotEmptyString(config.siteConfig.registerMails)) {
      let allowSuffix = false
      const emailSuffixs = config.siteConfig.registerMails.split(',')
      for (let index = 0; index < emailSuffixs.length; index++) {
        const element = emailSuffixs[index]
        allowSuffix = username.toLowerCase().endsWith(element)
        if (allowSuffix)
          break
      }
      if (!allowSuffix) {
        res.send({ status: 'Fail', message: '不支援使用該類郵箱註冊 | Unsupported email service provider', data: null })
        return
      }
    }

    const user = await getUser(username)
    if (user != null) {
      if (user.status === Status.PreVerify) {
        await sendVerifyMail(username, await getUserVerifyUrl(username))
        throw new Error('請到您的郵箱查閲驗証電郵 | Please go to your mailbox and verify your email address.')
      }
      if (user.status === Status.AdminVerify)
        throw new Error('請等待管理員開通 | Please wait for your new account to be activated manually')
      res.send({ status: 'Fail', message: '賬號已存在 | An account with this email address already exists', data: null })
      return
    }
    const newPassword = md5(password)
    const isRoot = username.toLowerCase() === process.env.ROOT_USER
    await createUser(username, newPassword, isRoot ? [UserRole.Admin] : [UserRole.User])

    if (isRoot) {
      res.send({ status: 'Success', message: '註冊成功 | Signup successful', data: null })
    }
    else {
      await sendVerifyMail(username, await getUserVerifyUrl(username))
      res.send({ status: 'Success', message: '註冊成功, 請驗証您的電郵 | Signup successful! Proceed to email verification.', data: null })
    }
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/config', rootAuth, async (req, res) => {
  try {
    const userId = req.headers.userId.toString()

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal || !user.roles.includes(UserRole.Admin))
      throw new Error('無權限 | No permission.')

    const response = await chatConfig()
    res.send(response)
  }
  catch (error) {
    res.send(error)
  }
})

router.post('/session', async (req, res) => {
  try {
    const config = await getCacheConfig()
    const hasAuth = config.siteConfig.loginEnabled
    const allowRegister = (await getCacheConfig()).siteConfig.registerEnabled
    if (config.apiModel !== 'ChatGPTAPI' && config.apiModel !== 'ChatGPTUnofficialProxyAPI')
      config.apiModel = 'ChatGPTAPI'
    const userId = await getUserId(req)
    const chatModels: {
      label
      key: string
      value: string
    }[] = []

    const chatModelOptions = config.siteConfig.chatModels.split(',').map((model: string) => {
      let label = model
      if (model === 'text-davinci-002-render-sha-mobile')
        label = 'gpt-3.5-mobile'
      return {
        label,
        key: model,
        value: model,
      }
    })

    let userInfo: { name: string; description: string; avatar: string; userId: string; root: boolean; roles: UserRole[]; config: UserConfig }
    if (userId != null) {
      const user = await getUserById(userId)
      userInfo = {
        name: user.name,
        description: user.description,
        avatar: user.avatar,
        userId: user._id.toString(),
        root: user.roles.includes(UserRole.Admin),
        roles: user.roles,
        config: user.config,
      }

      const keys = (await getCacheApiKeys()).filter(d => hasAnyRole(d.userRoles, user.roles))

      const count: { key: string; count: number }[] = []
      chatModelOptions.forEach((chatModel) => {
        keys.forEach((key) => {
          if (key.chatModels.includes(chatModel.value)) {
            if (count.filter(d => d.key === chatModel.value).length <= 0) {
              count.push({ key: chatModel.value, count: 1 })
            }
            else {
              const thisCount = count.filter(d => d.key === chatModel.value)[0]
              thisCount.count++
            }
          }
        })
      })
      count.forEach((c) => {
        const thisChatModel = chatModelOptions.filter(d => d.value === c.key)[0]
        const suffix = c.count > 1 ? ` (${c.count})` : ''
        chatModels.push({
          label: `${thisChatModel.label}${suffix}`,
          key: c.key,
          value: c.key,
        })
      })
    }

    res.send({
      status: 'Success',
      message: '',
      data: {
        auth: hasAuth,
        allowRegister,
        model: config.apiModel,
        title: config.siteConfig.siteTitle,
        chatModels,
        allChatModels: chatModelOptions,
        userInfo,
      },
    })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-login', authLimiter, async (req, res) => {
  try {
    const { username, password, token } = req.body as { username: string; password: string; token?: string }
    if (!username || !password || !isEmail(username))
      throw new Error('用戶名或密碼為空 | Username or password is empty')

    const user = await getUser(username)
    if (user == null || user.password !== md5(password))
      throw new Error('用户不存在或密码错误 | User does not exist or incorrect password.')
    if (user.status === Status.PreVerify)
      throw new Error('請到您的郵箱查閲驗証電郵 | Please go to your mailbox and verify your email address.')
    if (user != null && user.status === Status.AdminVerify)
      throw new Error('請等待管理員開通您的新賬戶 | Please wait for your new account to be activated manually.')
    if (user.status !== Status.Normal)
      throw new Error('賬戶狀態異常 | Account status abnormal.')
    if (user.secretKey) {
      if (token) {
        const verified = speakeasy.totp.verify({
          secret: user.secretKey,
          encoding: 'base32',
          token,
        })
        if (!verified)
          throw new Error('驗證碼錯誤 | Two-step verification code error')
      }
      else {
        res.send({ status: 'Success', message: '需要兩步驗證 | Two-step verification required', data: { need2FA: true } })
        return
      }
    }

    const config = await getCacheConfig()
    const jwtToken = jwt.sign({
      name: user.name ? user.name : user.email,
      avatar: user.avatar,
      description: user.description,
      userId: user._id,
      root: user.roles.includes(UserRole.Admin),
      config: user.config,
    }, config.siteConfig.loginSalt.trim())
    res.send({ status: 'Success', message: '登錄成功 | Login successful', data: { token: jwtToken } })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-send-reset-mail', authLimiter, async (req, res) => {
  try {
    const { username } = req.body as { username: string }
    if (!username || !isEmail(username))
      throw new Error('請輸入格式正確的郵箱 | Please enter a correctly formatted email address.')

    const user = await getUser(username)
    if (user == null || user.status !== Status.Normal)
      throw new Error('賬戶狀態異常 | Account status abnormal.')
    await sendResetPasswordMail(username, await getUserResetPasswordUrl(username))
    res.send({ status: 'Success', message: '重置郵件已發送 | Reset email has been sent', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-reset-password', authLimiter, async (req, res) => {
  try {
    const { username, password, sign } = req.body as { username: string; password: string; sign: string }
    if (!username || !password || !isEmail(username))
      throw new Error('使用者名或密碼為空 | Username or password is empty')
    if (!sign || !checkUserResetPassword(sign, username))
      throw new Error('連結失效，請重新送出。 | The link is invalid. Please resend.')
    const user = await getUser(username)
    if (user == null || user.status !== Status.Normal)
      throw new Error('賬戶狀態異常 | Account status abnormal.')

    updateUserPassword(user._id.toString(), md5(password))

    res.send({ status: 'Success', message: '密碼重置成功 | Password reset successful', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-info', auth, async (req, res) => {
  try {
    const { name, avatar, description } = req.body as UserInfo
    const userId = req.headers.userId.toString()

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal)
      throw new Error('用戶不存在 | User does not exist.')
    await updateUserInfo(userId, { name, avatar, description } as UserInfo)
    res.send({ status: 'Success', message: '更新成功 | Update successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-chat-model', auth, async (req, res) => {
  try {
    const { chatModel } = req.body as { chatModel: string }
    const userId = req.headers.userId.toString()

    const user = await getUserById(userId)
    if (user == null || user.status !== Status.Normal)
      throw new Error('用户不存在 | User does not exist.')
    await updateUserChatModel(userId, chatModel)
    res.send({ status: 'Success', message: '更新成功 | Update successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.get('/users', rootAuth, async (req, res) => {
  try {
    const page = +req.query.page
    const size = +req.query.size
    const data = await getUsers(page, size)
    res.send({ status: 'Success', message: '獲取成功 | Retrieved successfully', data })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-status', rootAuth, async (req, res) => {
  try {
    const { userId, status } = req.body as { userId: string; status: Status }
    const user = await getUserById(userId)
    await updateUserStatus(userId, status)
    if ((user.status === Status.PreVerify || user.status === Status.AdminVerify) && status === Status.Normal)
      await sendNoticeMail(user.email)
    res.send({ status: 'Success', message: '更新成功 | Update successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-edit', rootAuth, async (req, res) => {
  try {
    const { userId, email, password, roles, remark } = req.body as { userId?: string; email: string; password: string; roles: UserRole[]; remark?: string }
    if (userId) {
      await updateUser(userId, roles, password, remark)
    }
    else {
      const newPassword = md5(password)
      const user = await createUser(email, newPassword, roles, remark)
      await updateUserStatus(user._id.toString(), Status.Normal)
    }
    res.send({ status: 'Success', message: '更新成功 | Update successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-password', auth, async (req, res) => {
  try {
    let { oldPassword, newPassword, confirmPassword } = req.body as { oldPassword: string; newPassword: string; confirmPassword: string }
    if (!oldPassword || !newPassword || !confirmPassword)
      throw new Error('密碼不能為空 | Password cannot be empty')
    if (newPassword !== confirmPassword)
      throw new Error('兩次密碼不一致 | The two passwords are inconsistent')
    if (newPassword === oldPassword)
      throw new Error('新密碼不能與舊密碼相同 | The new password cannot be the same as the old password')
    if (newPassword.length < 6)
      throw new Error('密碼長度不能小於6位 | The password length cannot be less than 6 digits')

    const userId = req.headers.userId.toString()
    oldPassword = md5(oldPassword)
    newPassword = md5(newPassword)
    const result = await updateUserPasswordWithVerifyOld(userId, oldPassword, newPassword)
    if (result.matchedCount <= 0)
      throw new Error('舊密碼錯誤 | Old password error')
    if (result.modifiedCount <= 0)
      throw new Error('更新失敗 | Update error')
    res.send({ status: 'Success', message: '更新成功 | Update successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.get('/user-2fa', auth, async (req, res) => {
  try {
    const userId = req.headers.userId.toString()
    const user = await getUserById(userId)

    const data = new TwoFAConfig()
    if (user.secretKey) {
      data.enaled = true
    }
    else {
      const secret = speakeasy.generateSecret({ length: 20, name: `CHATGPT-WEB:${user.email}` })
      data.otpauthUrl = secret.otpauth_url
      data.enaled = false
      data.secretKey = secret.base32
      data.userName = user.email
    }
    res.send({ status: 'Success', message: '獲取成功 | Operation successful', data })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-2fa', auth, async (req, res) => {
  try {
    const { secretKey, token } = req.body as { secretKey: string; token: string }
    const userId = req.headers.userId.toString()

    const verified = speakeasy.totp.verify({
      secret: secretKey,
      encoding: 'base32',
      token,
    })
    if (!verified)
      throw new Error('驗證失敗 | Verification failed')
    await updateUser2FA(userId, secretKey)
    res.send({ status: 'Success', message: '開啟成功 | Enabled 2FA successfully' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-disable-2fa', auth, async (req, res) => {
  try {
    const { token } = req.body as { token: string }
    const userId = req.headers.userId.toString()
    const user = await getUserById(userId)
    if (!user || !user.secretKey)
      throw new Error('未開啟 2FA | 2FA not enabled')
    const verified = speakeasy.totp.verify({
      secret: user.secretKey,
      encoding: 'base32',
      token,
    })
    if (!verified)
      throw new Error('驗證失敗 | Verification failed')
    await disableUser2FA(userId)
    res.send({ status: 'Success', message: '關閉 2FA 成功 | Disabled 2FA successfully' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/user-disable-2fa-admin', rootAuth, async (req, res) => {
  try {
    const { userId } = req.body as { userId: string }
    await disableUser2FA(userId)
    res.send({ status: 'Success', message: '關閉 2FA 成功 | Disabled 2FA successfully' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/verify', authLimiter, async (req, res) => {
  try {
    const { token } = req.body as { token: string }
    if (!token)
      throw new Error('Secret key is empty')
    const username = await checkUserVerify(token)
    const user = await getUser(username)
    if (user == null)
      throw new Error('賬號不存在 | This account does not exists')
    if (user.status === Status.Deleted)
      throw new Error('賬號已禁用 | This account has been blocked')
    if (user.status === Status.Normal)
      throw new Error('賬號已存在 | This account already exists')
    if (user.status === Status.AdminVerify)
      throw new Error('請等待管理員開通您的新賬戶 | Please wait for the admin to activate your new account')
    if (user.status !== Status.PreVerify)
      throw new Error('賬號異常 | This account has an abnormal status')

    const config = await getCacheConfig()
    let message = '驗証成功 | Email address verified successfully'
    if (config.siteConfig.registerReview) {
      await verifyUser(username, Status.AdminVerify)
      await sendVerifyMailAdmin(process.env.ROOT_USER, username, await getUserVerifyUrlAdmin(username))
      message = '驗証成功, 請等待管理員開通您的新賬戶 | Email address successfully verified. Please wait for the admin to activate your new account.'
    }
    else {
      await verifyUser(username, Status.Normal)
    }
    res.send({ status: 'Success', message, data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/verifyadmin', authLimiter, async (req, res) => {
  try {
    const { token } = req.body as { token: string }
    if (!token)
      throw new Error('Secret key is empty')
    const username = await checkUserVerifyAdmin(token)
    const user = await getUser(username)
    if (user == null)
      throw new Error('賬戶不存在 | This acoount does not exist')
    if (user.status !== Status.AdminVerify)
      throw new Error(`賬號異常 ${user.status} | This account has an abnormal status ${user.status}`)

    await verifyUser(username, Status.Normal)
    await sendNoticeMail(username)
    res.send({ status: 'Success', message: '成功激活賬戶! | Account activated successfully!', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-base', rootAuth, async (req, res) => {
  try {
    const { apiKey, apiModel, apiBaseUrl, accessToken, timeoutMs, reverseProxy, socksProxy, socksAuth, httpsProxy } = req.body as Config

    const thisConfig = await getOriginConfig()
    thisConfig.apiKey = apiKey
    thisConfig.apiModel = apiModel
    thisConfig.apiBaseUrl = apiBaseUrl
    thisConfig.accessToken = accessToken
    thisConfig.reverseProxy = reverseProxy
    thisConfig.timeoutMs = timeoutMs
    thisConfig.socksProxy = socksProxy
    thisConfig.socksAuth = socksAuth
    thisConfig.httpsProxy = httpsProxy
    await updateConfig(thisConfig)
    clearConfigCache()
    const response = await chatConfig()
    res.send({ status: 'Success', message: '操作成功 | Operation Success', data: response.data })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-site', rootAuth, async (req, res) => {
  try {
    const config = req.body as SiteConfig

    const thisConfig = await getOriginConfig()
    thisConfig.siteConfig = config
    const result = await updateConfig(thisConfig)
    clearConfigCache()
    res.send({ status: 'Success', message: '操作成功 | Operation Success', data: result.siteConfig })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-mail', rootAuth, async (req, res) => {
  try {
    const config = req.body as MailConfig

    const thisConfig = await getOriginConfig()
    thisConfig.mailConfig = config
    const result = await updateConfig(thisConfig)
    clearConfigCache()
    res.send({ status: 'Success', message: '操作成功 | Operation Success', data: result.mailConfig })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/mail-test', rootAuth, async (req, res) => {
  try {
    const config = req.body as MailConfig
    const userId = req.headers.userId as string
    const user = await getUserById(userId)
    await sendTestMail(user.email, config)
    res.send({ status: 'Success', message: '發送成功 | Delivery Success', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-audit', rootAuth, async (req, res) => {
  try {
    const config = req.body as AuditConfig

    const thisConfig = await getOriginConfig()
    thisConfig.auditConfig = config
    const result = await updateConfig(thisConfig)
    clearConfigCache()
    if (config.enabled)
      initAuditService(config)
    res.send({ status: 'Success', message: '操作成功 | Operation Successful', data: result.auditConfig })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/audit-test', rootAuth, async (req, res) => {
  try {
    const { audit, text } = req.body as { audit: AuditConfig; text: string }
    const config = await getCacheConfig()
    if (audit.enabled)
      initAuditService(audit)
    const result = await containsSensitiveWords(audit, text)
    if (audit.enabled)
      initAuditService(config.auditConfig)
    res.send({ status: 'Success', message: result ? '含敏感詞 | Contains sensitive words' : '不含敏感詞 | Does not contain sensitive words.', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.get('/setting-keys', rootAuth, async (req, res) => {
  try {
    const result = await getApiKeys()
    res.send({ status: 'Success', message: null, data: result })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-key-status', rootAuth, async (req, res) => {
  try {
    const { id, status } = req.body as { id: string; status: Status }
    await updateApiKeyStatus(id, status)
    clearApiKeyCache()
    res.send({ status: 'Success', message: '更新成功 | Update successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/setting-key-upsert', rootAuth, async (req, res) => {
  try {
    const keyConfig = req.body as KeyConfig
    if (keyConfig._id !== undefined)
      keyConfig._id = new ObjectId(keyConfig._id)
    await upsertKey(keyConfig)
    clearApiKeyCache()
    res.send({ status: 'Success', message: '成功 | Successful' })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/statistics/by-day', auth, async (req, res) => {
  try {
    const userId = req.headers.userId
    const { start, end } = req.body as { start: number; end: number }

    const data = await getUserStatisticsByDay(new ObjectId(userId as string), start, end)
    res.send({ status: 'Success', message: '', data })
  }
  catch (error) {
    res.send(error)
  }
})

app.use('', router)
app.use('/api', router)

app.listen(3002, () => globalThis.console.log('Server is running on port 3002'))

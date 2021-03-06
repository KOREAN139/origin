'use strict'

const logger = require('../logger')

const { GrowthEvent } = require('@origin/growth-shared/src/resources/event')
const { GrowthEventTypes } = require('@origin/growth-shared/src/enums')

const db = require('@origin/identity/src/models')

const EventValidators = require('./event-validators')

const {
  getEventContent,
  getUserProfileFromEvent,
  hashContent,
  getUntranslatedContent
} = require('./webhook-helpers')

const PromotionEventToGrowthEvent = {
  TWITTER: {
    FOLLOW: GrowthEventTypes.FollowedOnTwitter,
    SHARE: GrowthEventTypes.SharedOnTwitter
  },
  TELEGRAM: {
    FOLLOW: GrowthEventTypes.FollowedOnTelegram
  }
}

/**
 * @param socialNetwork Could be one of ['TWITTER', 'TELEGRAM']
 * @returns true if event is valid, false otherwise
 */
const isEventValid = ({ socialNetwork, ...args }) => {
  const validator = EventValidators[socialNetwork.toUpperCase()]

  if (!validator) {
    logger.error(`Error when trying to parse event: ${socialNetwork}`, args)
    return false
  }

  return validator(args)
}

/**
 * Creates a growth event for the verified social action.
 *
 * @param {string} content: content that was shared. null for a 'FOLLOW' action.
 * @param {string} identity: eth address of the user
 * @param {Object} event: event sent by social network describing the user action
 * @param {string} socialNetwork:
 * @param {string} type: type of action: 'SHARE' || 'FOLLOW'
 * @returns {Promise<boolean>} Returns true in case of success, false otherwise
 */
const insertGrowthEvent = async ({
  contentHash,
  identity,
  event,
  socialNetwork,
  type
}) => {
  try {
    const profile = getUserProfileFromEvent({
      event,
      socialNetwork,
      type
    })

    const key = `${socialNetwork.toLowerCase()}Profile` // twitterProfile | telegramProfile

    logger.debug(`${key}: ${JSON.stringify(profile)}`)
    await GrowthEvent.insert(
      logger,
      1, // insert a single entry
      identity,
      PromotionEventToGrowthEvent[socialNetwork][type],
      contentHash, // set customId to the content hash.
      // Store the raw event and the profile data that contains the user's social stats in the GrowthEvent.data column.
      // Note: the raw event is mostly for debugging purposes. If it starts taking too much storage
      // we could stop storing it in the DB.
      { event, [key]: profile },
      Date.now()
    )
  } catch (e) {
    logger.error(
      `Failed to store ${type} event for ${identity} on ${socialNetwork}`,
      e
    )
    return false
  }

  logger.info(
    `Logged GrowthEvent. User ${identity} socialNetwork ${socialNetwork} event ${type}`
  )
  return true
}

/**
 * Fetches and returns attestation from db, if exists
 */
const getAttestation = async ({ username, socialNetwork }) => {
  return await db.Attestation.findOne({
    where: {
      username,
      // TODO: This may need a mapping
      method: socialNetwork
    },
    order: [['createdAt', 'DESC']]
  })
}

module.exports = async ({ type, socialNetwork, username, event }) => {
  try {
    if (!isEventValid({ socialNetwork, type, event })) {
      logger.debug(`Dropping invalid event from ${username}`)
      return
    }

    const attestation = await getAttestation({
      socialNetwork,
      username
    })

    if (!attestation) {
      logger.debug('No attestation found for address. Ignoring event.')
      return
    }

    const identity = attestation.ethAddress

    const content = getEventContent({ type, event })

    const contentHash = content
      ? hashContent(getUntranslatedContent(content))
      : null

    logger.debug(`content hash: ${contentHash}`)

    const stored = await insertGrowthEvent({
      contentHash,
      identity,
      event,
      socialNetwork,
      type
    })

    if (!stored) {
      logger.error(
        `Failed to insert GrowthEvent of ${type} event for ${identity}`
      )
    }
  } catch (err) {
    logger.error(
      `Failed to insert GrowthEvent of ${type} event for ${username} on ${socialNetwork}`,
      err
    )
  }
}

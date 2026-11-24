# Adult profiles

Adult profiles can search and play songs, albums and playlists across Spotify and the other sources connected to Music Assistant, without adding that music to the children's approved shelf. Search depends on the sources and account access configured in Music Assistant.

1. Open **Parent settings → Children & preferences**.
2. Choose **Adult · full catalogue**, enter a name/avatar, and press **Add adult**.
3. Under **Paired players**, assign that profile to the desired display and press **Save player**.
4. Open the player. Its header shows **Adult**, and **Search all music** appears above the shelf. Open a result, then choose a song or Play all. Voice search also uses the full catalogue for adults.

Hearts and thumbs-down belong to the adult profile. **My favourites** includes songs liked while using that profile, including music outside the children's approved collection. Adult playback does not approve music for any child. Shuffle, repeat and independent device playback continue to work. Shared bedtime, screen and volume policies still apply.

On a shared display, press the header's **lock** icon to stop adult playback and return to the previously assigned child profile (or the first available child). Adult assignment remains active across refreshes until locked or changed by a parent; lock it before handing the device to a child. Re-entering adult access requires parent settings. Adult access does not grant access to parent administration.

Only a parent can create, change or assign an adult profile. New pairings always start with a child profile, and at least one child profile must remain. Existing profiles migrate to child access. Changing an adult profile to a child stops its playback and restores approved-only access; unapproved favourites become unavailable.

Search results expire after 15 minutes and are bound to the paired display, profile and profile revision. Search again if an old result is unavailable. An already playing queue can continue beyond that interval, while its adult assignment remains valid. Playback is passive after an app restart; search again to select a fresh catalogue queue.

Implementation uses additive migration `004_adult_profiles.sql`. It does not change existing approvals, profile names, tastes, pairings or the parent password. For code rollback use the previous image with the current database; do not restore an older database.
